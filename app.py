# -*- coding: utf-8 -*-
from __future__ import annotations

import eventlet
eventlet.monkey_patch()  # Важно: патч должен идти в самом верху для стабильных веб-сокетов

import json
import os
import secrets
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for
from flask_socketio import SocketIO, join_room, leave_room, emit
from werkzeug.utils import secure_filename
try:
    import cloudinary
    from cloudinary import uploader as cloudinary_uploader
    from cloudinary.utils import cloudinary_url as cloudinary_url_for
except ImportError:  # pragma: no cover - optional dependency
    cloudinary = None
    cloudinary_uploader = None
    cloudinary_url_for = None

from auth_store import (
    NicknameAlreadyExistsError,
    add_user_subscription,
    _clamp_points,
    calculate_reputation_level,
    create_user,
    get_or_create_user_profile,
    get_user_by_nickname,
    get_user_subscriptions,
    get_user_followers_count,
    remove_user_subscription,
    rename_user_profile,
    update_user_avatar_path,
    update_user_nickname,
    update_user_password,
    update_user_profile_fields,
    verify_user_credentials,
    adjust_user_reputation,
    set_level_up_pending,
    get_reputation_state,
)
from config import (
    ALLOWED_AVATAR_EXTENSIONS,
    AVATAR_UPLOAD_DIR,
    CATEGORY_DEFINITIONS,
    CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET,
    CLOUDINARY_AVATAR_FOLDER,
    CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_ENABLED,
    CLOUDINARY_FORCE_UPLOADS,
    CLOUDINARY_STORAGE_PREFIX,
    CLOUDINARY_URL,
    MAP_DEFAULTS,
    MAX_AVATAR_FILE_SIZE,
    SECRET_KEY,
    SHARING_META,
)
from database import (
    LOCAL_MODE,
    _LOCAL_MESSAGES_STORE,
    active_authors_recently,
    ensure_connection,
    init_schema,
    messages_table,
    pins_table,
    profiles_table,
    session_scope,
    users_table,
    user_subscriptions_table,
)
from models import (
    User,
    active_pins,
    add_comment,
    comments_for_pins,
    count_active_pins_for_user,
    count_active_pins_for_users,
    create_pin,
    delete_comment,
    delete_pin,
    get_pin_by_id,
    get_pin_owner,
    get_user_rating_total,
    count_user_markers,
    count_user_likes_received,
    is_author_active_recently,
    record_vote,
    reassign_user_id,
    user_votes_for_pins,
    vote_counts_for_pins,
)

USER_MARKER_LIMIT = 5
USER_LIMIT_MESSAGE = (
    'Вы достигли лимита в 5 меток. Пожалуйста, удалите старую или дождитесь её исчезновения.'
)


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.secret_key = SECRET_KEY

    cloudinary_url = os.getenv("CLOUDINARY_URL") or CLOUDINARY_URL
    cloudinary_creds = {
        "cloud_name": os.getenv("CLOUDINARY_CLOUD_NAME") or CLOUDINARY_CLOUD_NAME,
        "api_key": os.getenv("CLOUDINARY_API_KEY") or CLOUDINARY_API_KEY,
        "api_secret": os.getenv("CLOUDINARY_API_SECRET") or CLOUDINARY_API_SECRET,
    }
    has_creds = all(cloudinary_creds.values())
    cloudinary_ready = False

    if CLOUDINARY_ENABLED and cloudinary:
        try:
            if cloudinary_url:
                cloudinary.config(cloudinary_url=cloudinary_url, secure=True)
            elif has_creds:
                cloudinary.config(secure=True, **cloudinary_creds)
            else:
                raise RuntimeError("Cloudinary credentials are not configured")
            cloudinary_ready = True
            app.logger.info("Cloudinary storage is enabled for avatars")
        except Exception as exc:  # pragma: no cover - optional external service
            cloudinary_ready = False
            app.logger.warning(
                "Failed to configure Cloudinary, fallback to local uploads: %s",
                exc,
            )

    if CLOUDINARY_FORCE_UPLOADS and not cloudinary_ready:
        raise RuntimeError(
            "Cloudinary forced uploads enabled but credentials failed to configure"
        )

    def _ensure_avatar_upload_dir() -> None:
        try:
            AVATAR_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            app.logger.debug("Проверка директории аватаров: %s", AVATAR_UPLOAD_DIR)
        except OSError as exc:  # pragma: no cover
            app.logger.warning("Не удалось создать каталог аватаров %s: %s", AVATAR_UPLOAD_DIR, exc)

    _ensure_avatar_upload_dir()

    # --- НАСТРОЙКА FLASK-ADMIN ---
    if not LOCAL_MODE:
        from database import SessionLocal
        from models import User, PinModel, Comment, UserProfile
        from flask_admin import Admin
        from flask_admin.contrib.sqla import ModelView
        from sqlalchemy.orm import scoped_session

        class SecureModelView(ModelView):
            def is_accessible(self):
                return session.get('is_admin') is True

            def inaccessible_logic(self, name, **kwargs):
                abort(403)
                
        admin_session = scoped_session(SessionLocal)
        admin_panel = Admin(app, name='LiveMap Admin', url='/admin-panel')
        admin_panel.add_view(SecureModelView(User, admin_session, name='Пользователи'))
        admin_panel.add_view(SecureModelView(UserProfile, admin_session, name='Профили'))
        admin_panel.add_view(SecureModelView(PinModel, admin_session, name='Метки'))
        admin_panel.add_view(SecureModelView(Comment, admin_session, name='Комментарии'))
    # -----------------------------

    try:
        init_schema()
        ensure_connection()
    except Exception as exc:  # pragma: no cover - warm-up only
        app.logger.warning("Database warm-up skipped: %s", exc)

    def _serialize_datetime(value):
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return value.isoformat()

    def _serialize_profile(profile: dict | None) -> dict | None:
        if not profile:
            return None
        raw_age = profile.get("age")
        try:
            age_value = int(raw_age)
            if age_value < 0:
                age_value = None
        except (TypeError, ValueError):
            age_value = None
        gender_value = profile.get("gender") or None
        avatar_filename = profile.get("avatar_path")
        avatar_url = None
        if avatar_filename:
            if isinstance(avatar_filename, str) and avatar_filename.startswith(("http://", "https://")):
                avatar_url = avatar_filename
            elif avatar_filename.startswith(CLOUDINARY_STORAGE_PREFIX):
                if cloudinary_url_for:
                    public_id = avatar_filename.split(CLOUDINARY_STORAGE_PREFIX, 1)[-1]
                    avatar_url = cloudinary_url_for(public_id, secure=True)[0]
            else:
                avatar_url = url_for("static", filename=f"uploads/avatars/{avatar_filename}")
        return {
            "nickname": profile.get("nickname"),
            "age": age_value,
            "gender": gender_value,
            "avatar_url": avatar_url,
            "avatar_path": avatar_filename,
            "reputation_points": profile.get("reputation_points", 0),
            "level_up_pending": bool(profile.get("level_up_pending") or False),
            "is_verified": bool(profile.get("is_verified") or False),
            "created_at": _serialize_datetime(profile.get("created_at")),
            "updated_at": _serialize_datetime(profile.get("updated_at")),
        }

    def _build_user_state(nickname: str) -> dict:
        base = {
            "nickname": nickname,
            "age": None,
            "gender": None,
            "avatar_url": None,
            "rating_total": 0,
            "reputation_points": 0,
            "reputation_level": 0,
            "level_up_pending": False,
            "is_verified": False,
            "is_admin": False,
            "profile": None,
            "subscriptions": [],
            "followers_count": 0,
        }
        # На сервере форсируем работу с реальной СУБД, игнорируя LOCAL_MODE для стейта
        if LOCAL_MODE and not os.getenv("DATABASE_URL"):
            base["rating_total"] = get_user_rating_total(nickname)
            reputation = get_reputation_state(nickname)
            base.update(reputation)
            try:
                profile = get_or_create_user_profile(nickname)
            except Exception as exc:  # pragma: no cover
                app.logger.exception("Failed to load profile for %s: %s", nickname, exc)
                return base
            serialized = _serialize_profile(profile)
            if serialized:
                base.update(
                    {
                        "age": serialized.get("age"),
                        "gender": serialized.get("gender"),
                        "avatar_url": serialized.get("avatar_url"),
                        "profile": serialized,
                    }
                )
            try:
                base["subscriptions"] = get_user_subscriptions(nickname)
            except Exception:  # pragma: no cover
                base["subscriptions"] = []
            try:
                base["followers_count"] = get_user_followers_count(nickname)
            except Exception:  # pragma: no cover
                base["followers_count"] = 0
            return base

        try:
            get_or_create_user_profile(nickname)
        except Exception as exc:  # pragma: no cover
            app.logger.exception("Failed to ensure profile for %s: %s", nickname, exc)
            return base

        from sqlalchemy import func, select

        now_iso = datetime.now(timezone.utc)
        rating_subq = (
            select(
                pins_table.c.user_id.label("user_id"),
                func.coalesce(func.sum(pins_table.c.rating), 0).label("rating_total"),
            )
            .where(
                pins_table.c.user_id == nickname,
                (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
            )
            .group_by(pins_table.c.user_id)
            .subquery()
        )
        followers_subq = (
            select(
                user_subscriptions_table.c.author_id.label("author_id"),
                func.count().label("followers_count"),
            )
            .where(user_subscriptions_table.c.author_id == nickname)
            .group_by(user_subscriptions_table.c.author_id)
            .subquery()
        )
        profile_stmt = (
            select(
                profiles_table.c.nickname,
                profiles_table.c.age,
                profiles_table.c.gender,
                profiles_table.c.avatar_path,
                profiles_table.c.reputation_points,
                profiles_table.c.level_up_pending,
                profiles_table.c.is_verified,
                profiles_table.c.created_at,
                profiles_table.c.updated_at,
                users_table.c.is_admin,
                func.coalesce(rating_subq.c.rating_total, 0).label("rating_total"),
                func.coalesce(followers_subq.c.followers_count, 0).label("followers_count"),
            )
            .select_from(
                profiles_table
                .outerjoin(users_table, users_table.c.nickname == profiles_table.c.nickname)
                .outerjoin(rating_subq, rating_subq.c.user_id == profiles_table.c.nickname)
                .outerjoin(followers_subq, followers_subq.c.author_id == profiles_table.c.nickname)
            )
            .where(profiles_table.c.nickname == nickname)
        )
        try:
            with session_scope() as session:
                row = session.execute(profile_stmt).mappings().first()
                if not row:
                    app.logger.warning("Profile row missing for %s after ensure, skipping data aggregation", nickname)
                    return base

                profile_data = dict(row)
                base["rating_total"] = int(profile_data.get("rating_total") or 0)
                points = _clamp_points(profile_data.get("reputation_points", 0))
                base["reputation_points"] = points
                base["reputation_level"] = calculate_reputation_level(points)
                base["level_up_pending"] = bool(profile_data.get("level_up_pending") or False)
                base["is_verified"] = bool(profile_data.get("is_verified") or False)
                serialized = _serialize_profile(profile_data)
                if serialized:
                    base.update(
                        {
                            "age": serialized.get("age"),
                            "gender": serialized.get("gender"),
                            "avatar_url": serialized.get("avatar_url"),
                            "profile": serialized,
                        }
                    )
                else:
                    base["profile"] = None
                base["followers_count"] = int(profile_data.get("followers_count") or 0)
                base["is_admin"] = bool(profile_data.get("is_admin") or False)

                subs_stmt = select(user_subscriptions_table.c.author_id).where(
                    user_subscriptions_table.c.follower_id == nickname
                )
                raw_subs = session.execute(subs_stmt).scalars().all()
                base["subscriptions"] = [str(value or "").lower() for value in raw_subs if value]
        except Exception as exc:
            app.logger.exception("_build_user_state failed for %s: %s", nickname, exc)
            base["subscriptions"] = []
            base["followers_count"] = 0
        return base

    def _build_author_preview(nickname: str) -> dict:
        base = {
            "nickname": nickname,
            "age": None,
            "gender": None,
            "avatar_url": None,
            "rating_total": 0,
            "reputation_points": 0,
            "reputation_level": 0,
            "level_up_pending": False,
            "is_verified": False,
        }

        if LOCAL_MODE and not os.getenv("DATABASE_URL"):
            return _build_user_state(nickname)

        from sqlalchemy import func, select

        now_iso = datetime.now(timezone.utc)
        try:
            with session_scope() as session:
                profile_stmt = select(
                    profiles_table.c.nickname,
                    profiles_table.c.age,
                    profiles_table.c.gender,
                    profiles_table.c.avatar_path,
                    profiles_table.c.reputation_points,
                    profiles_table.c.level_up_pending,
                    profiles_table.c.is_verified,
                    profiles_table.c.created_at,
                    profiles_table.c.updated_at,
                ).where(profiles_table.c.nickname == nickname)
                profile_row = session.execute(profile_stmt).mappings().first()

                rating_stmt = (
                    select(func.coalesce(func.sum(pins_table.c.rating), 0))
                    .where(
                        pins_table.c.user_id == nickname,
                        (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
                    )
                )
                rating_total = int(session.execute(rating_stmt).scalar() or 0)

            base["rating_total"] = rating_total

            if profile_row:
                profile_dict = dict(profile_row)
                points = _clamp_points(profile_dict.get("reputation_points", 0))
                base["reputation_points"] = points
                base["reputation_level"] = calculate_reputation_level(points)
                base["level_up_pending"] = bool(profile_dict.get("level_up_pending") or False)
                base["is_verified"] = bool(profile_dict.get("is_verified") or False)

                serialized = _serialize_profile(profile_dict)
                if serialized:
                    base["age"] = serialized.get("age")
                    base["gender"] = serialized.get("gender")
                    base["avatar_url"] = serialized.get("avatar_url")
        except Exception as exc:
            app.logger.exception("_build_author_preview failed for %s: %s", nickname, exc)

        try:
            base["followers_count"] = get_user_followers_count(nickname)
        except Exception:
            base["followers_count"] = 0

        return base

    def current_user_payload() -> dict | None:
        nickname = session.get("user_nickname")
        if not nickname:
            return None
        user = get_user_by_nickname(nickname)
        if not user:
            session.pop("user_nickname", None)
            return None
        return _build_user_state(user.nickname)

    def _is_cloudinary_avatar(path: str | None) -> bool:
        return bool(path and path.startswith(CLOUDINARY_STORAGE_PREFIX))

    def _cloudinary_public_id(path: str) -> str:
        return path.split(CLOUDINARY_STORAGE_PREFIX, 1)[-1]

    def _upload_to_cloudinary(source: Path | BinaryIO, unique_name: str) -> str | None:
        if not (CLOUDINARY_ENABLED and cloudinary_uploader):
            return None
        public_id = unique_name.rsplit(".", 1)[0]
        try:
            upload_source = str(source) if isinstance(source, Path) else source
            if not isinstance(upload_source, str):
                upload_source.seek(0)
            upload_result = cloudinary_uploader.upload(
                upload_source,
                public_id=public_id,
                folder=CLOUDINARY_AVATAR_FOLDER,
                resource_type="image",
                overwrite=True,
                use_filename=False,
                unique_filename=False,
                width=3000,
                height=3000,
                crop="limit",
                format="webp",
                quality="auto"
            )
            secure_url = str(upload_result.get("secure_url") or "").strip()
            if secure_url:
                return secure_url
            return None
        except Exception as exc:  # pragma: no cover
            app.logger.warning("Cloudinary upload failed for %s: %s", unique_name, exc)
            return None

    def _delete_avatar_file(filename: str | None) -> None:
        if not filename:
            return
        if isinstance(filename, str) and filename.startswith(("http://", "https://")):
            return
        if _is_cloudinary_avatar(filename):
            if not cloudinary_uploader:
                return
            public_id = _cloudinary_public_id(filename)
            try:
                cloudinary_uploader.destroy(public_id, invalidate=True, resource_type="image")
            except Exception as exc:  # pragma: no cover
                app.logger.warning("Failed to delete Cloudinary avatar %s: %s", public_id, exc)
            return
        target_path = AVATAR_UPLOAD_DIR / filename
        try:
            if target_path.is_file():
                target_path.unlink()
        except OSError as exc:  # pragma: no cover
            app.logger.warning("Failed to delete avatar %s: %s", target_path, exc)

    def _validate_age(value):
        if value in (None, ""):
            return None
        try:
            age_int = int(value)
        except (TypeError, ValueError):
            raise ValueError("Возраст должен быть числом.") from None
        if age_int < 0 or age_int > 120:
            raise ValueError("Возраст должен быть в диапазоне 0-120.")
        return age_int

    def _validate_gender(value):
        if value in (None, ""):
            return None
        normalized = str(value).strip().upper()
        if normalized not in {"M", "F", "X"}:
            raise ValueError("Недопустимое значение поля 'пол'.")
        return normalized

    @app.route("/")
    def index() -> str:
        highlight_pin = request.args.get("pin", type=int)
        current_user = current_user_payload()
        share_meta = {
            "title": SHARING_META["site_name"],
            "description": "Живая карта интересов с категориями по Мото, Спорт, Рыбалка и Знакомства",
            "image": SHARING_META["default_image"],
            "url": request.url,
        }
        bootstrap_payload = {
            "defaults": MAP_DEFAULTS,
            "highlight_pin": highlight_pin,
            "share_meta": share_meta,
            "current_user": current_user,
        }
        bootstrap_json = json.dumps(bootstrap_payload, ensure_ascii=False)
        return render_template(
            "index.html",
            categories=CATEGORY_DEFINITIONS,
            defaults=MAP_DEFAULTS,
            highlight_pin=highlight_pin,
            share_meta=share_meta,
            bootstrap_json=bootstrap_json,
            bootstrap_payload=bootstrap_payload,
            current_user=current_user,
        )

    @app.route("/register", methods=["POST"])
    def register_user() -> tuple[dict, int]:
        payload = request.get_json(silent=True) or {}
        nickname = str(payload.get("nickname") or "").strip()
        password = str(payload.get("password") or "")

        if len(nickname) < 3:
            return {"message": "Nickname должен быть не короче 3 символов."}, 400
        if len(nickname) > 16:
            return {"message": "Nickname не может быть длиннее 16 символов."}, 400
        if len(password) < 6:
            return {"message": "Password должен быть не короче 6 символов."}, 400

        try:
            user = create_user(nickname, password)
        except Exception as exc:
            app.logger.exception("Register failed for nickname=%s: %s", nickname, exc)
            return {"message": "Не удалось завершить регистрацию. Попробуйте позже."}, 500
        if not user:
            return {"message": "Пользователь с таким именем уже существует."}, 409

        session["user_nickname"] = user.nickname
        session["is_admin"] = False
        return {"user": _build_user_state(user.nickname)}, 201

    @app.route("/login", methods=["POST"])
    def login_user() -> tuple[dict, int]:
        payload = request.get_json(silent=True) or {}
        nickname = str(payload.get("nickname") or "").strip()
        password = str(payload.get("password") or "")

        try:
            user = verify_user_credentials(nickname, password)
        except Exception as exc:
            app.logger.exception("Login failed for nickname=%s: %s", nickname, exc)
            return {"message": "Не удалось выполнить вход. Попробуйте позже."}, 500
        if not user:
            return {"message": "Неверные имя пользователя или пароль."}, 401

        session["user_nickname"] = user.nickname
        session["is_admin"] = bool(user.is_admin)
        return {"user": _build_user_state(user.nickname)}, 200

    @app.route("/profile/nickname", methods=["POST"])
    def update_profile_nickname() -> tuple[dict, int]:
        current_user = current_user_payload()
        if not current_user:
            return {"message": "Нужно войти в аккаунт."}, 401

        payload = request.get_json(silent=True) or {}
        next_nickname = str(payload.get("nickname") or "").strip()

        if len(next_nickname) < 3:
            return {"message": "Имя должно быть не короче 3 символов."}, 400
        if len(next_nickname) > 16:
            return {"message": "Имя должно быть не длиннее 16 символов."}, 400

        if next_nickname == current_user["nickname"]:
            return {"user": current_user}, 200

        try:
            updated_user = update_user_nickname(current_user["nickname"], next_nickname)
        except NicknameAlreadyExistsError:
            return {"message": "Пользователь с таким именем уже существует."}, 409
        except ValueError as exc:
            return {"message": str(exc)}, 400
        except Exception as exc:  # pragma: no cover
            app.logger.exception("Nickname update failed for nickname=%s: %s", current_user["nickname"], exc)
            return {"message": "Не удалось обновить имя. Попробуйте позже."}, 500

        try:
            reassign_user_id(current_user["nickname"], updated_user.nickname)
        except Exception as exc:  # pragma: no cover
            app.logger.exception("Failed to propagate nickname change from %s to %s: %s", current_user["nickname"], updated_user.nickname, exc)
            return {"message": "Не удалось применить новое имя во всех разделах."}, 500

        session["user_nickname"] = updated_user.nickname
        return {"user": _build_user_state(updated_user.nickname)}, 200

    @app.route("/logout", methods=["POST"])
    def logout_user() -> tuple[dict, int]:
        session.pop("user_nickname", None)
        session.pop("is_admin", None)
        return {"ok": True}, 200

    @app.route("/me", methods=["GET"])
    def me() -> tuple[dict, int]:
        user = current_user_payload()
        payload = {"authenticated": bool(user)}
        if user:
            nickname = user.get("nickname")
            payload["user"] = _build_user_state(nickname) if nickname else None
            payload["subscriptions"] = user.get("subscriptions") or []
        else:
            payload["user"] = None
            payload["subscriptions"] = []
        if user:
            payload_user = payload.get("user") or {}
            session["is_admin"] = bool(payload_user.get("is_admin", False))
        return payload, 200

    @app.route("/profile", methods=["PATCH"])
    def update_profile_fields() -> tuple[dict, int]:
        current_user = current_user_payload()
        if not current_user:
            return {"message": "Нужно войти в аккаунт."}, 401
        payload = request.get_json(silent=True) or {}
        updates = {}
        try:
            if "age" in payload:
                updates["age"] = _validate_age(payload.get("age"))
            if "gender" in payload:
                updates["gender"] = _validate_gender(payload.get("gender"))
        except ValueError as exc:
            return {"message": str(exc)}, 400

        original_nickname = current_user["nickname"]
        next_nickname = str(payload.get("nickname") or "").strip()
        if not next_nickname:
            next_nickname = original_nickname

        if next_nickname != original_nickname:
            try:
                updated_user = update_user_nickname(original_nickname, next_nickname)
            except NicknameAlreadyExistsError:
                return {"message": "Пользователь с таким именем уже существует."}, 409
            except ValueError as exc:
                return {"message": str(exc)}, 400
            except Exception as exc:  # pragma: no cover
                app.logger.exception("Nickname update failed for nickname=%s: %s", original_nickname, exc)
                return {"message": "Не удалось обновить имя. Попробуйте позже."}, 500

            try:
                reassign_user_id(original_nickname, updated_user.nickname)
            except Exception as exc:  # pragma: no cover
                app.logger.exception("Failed to propagate nickname change from %s to %s: %s", original_nickname, updated_user.nickname, exc)
                return {"message": "Не удалось применить новое имя во всех разделах."}, 500

            session["user_nickname"] = updated_user.nickname
            current_user = _build_user_state(updated_user.nickname)
            target_nickname = updated_user.nickname
        else:
            target_nickname = original_nickname

        profile = None
        if updates:
            profile = update_user_profile_fields(target_nickname, **updates)
        else:
            profile = get_or_create_user_profile(target_nickname)

        user_state = _build_user_state(target_nickname)
        return {"user": user_state, "profile": _serialize_profile(profile)}, 200

    @app.route("/profile/avatar", methods=["POST"])
    def upload_profile_avatar() -> tuple[dict, int]:
        current_user = current_user_payload()
        if not current_user:
            return {"message": "Нужно войти в аккаунт."}, 401
        file = request.files.get("avatar")
        if not file or not file.filename:
            return {"message": "Файл аватара не найден."}, 400
        filename = secure_filename(file.filename)
        if "." not in filename:
            return {"message": "Файл должен иметь расширение."}, 400
        ext = filename.rsplit(".", 1)[1].lower()
        if ext not in ALLOWED_AVATAR_EXTENSIONS:
            return {"message": "Недопустимый формат изображения."}, 400
        try:
            file.stream.seek(0, os.SEEK_END)
            size = file.stream.tell()
            file.stream.seek(0)
        except OSError:
            size = 0
        if size > MAX_AVATAR_FILE_SIZE:
            return {"message": "Файл слишком большой."}, 400
        unique_prefix = secrets.token_urlsafe(8)
        unique_name = f"{current_user['nickname']}-{unique_prefix}.{ext}"
        cloudinary_tagged = None
        cloudinary_available = CLOUDINARY_ENABLED and cloudinary_ready and cloudinary_uploader
        if cloudinary_available:
            file.stream.seek(0)
            cloudinary_tagged = _upload_to_cloudinary(file.stream, unique_name)
            if not cloudinary_tagged:
                return {"message": "Не удалось загрузить аватар в Cloudinary."}, 500
        else:
            target_path = AVATAR_UPLOAD_DIR / unique_name
            target_path.parent.mkdir(parents=True, exist_ok=True)
            file.stream.seek(0)
            file.save(target_path)
        profile = get_or_create_user_profile(current_user["nickname"])
        previous_avatar = profile.get("avatar_path")
        next_avatar_path = cloudinary_tagged or unique_name
        profile = update_user_avatar_path(current_user["nickname"], next_avatar_path)
        if previous_avatar and previous_avatar != next_avatar_path:
            _delete_avatar_file(previous_avatar)
        user_state = _build_user_state(current_user["nickname"])
        return {"user": user_state, "profile": _serialize_profile(profile)}, 200

    @app.route("/profile/password", methods=["POST"])
    def change_profile_password() -> tuple[dict, int]:
        current_user = current_user_payload()
        if not current_user:
            return {"message": "Нужно войти в аккаунт."}, 401
        payload = request.get_json(silent=True) or {}
        current_password = str(payload.get("current_password") or "")
        new_password = str(payload.get("new_password") or "")
        if not current_password or not new_password:
            return {"message": "Укажите текущий и новый пароль."}, 400
        if len(new_password) < 6:
            return {"message": "Новый пароль должен быть не короче 6 символов."}, 400
        try:
            update_user_password(current_user["nickname"], current_password, new_password)
        except ValueError as exc:
            return {"message": str(exc)}, 400
        return {"message": "Пароль обновлён."}, 200

    @app.route("/api/pins", methods=["GET", "POST"])
    def refresh_or_create_pin():
        if request.method == "GET":
            categories = request.args.get("subcategories")
            threshold = request.args.get("rating", default=-999, type=int)
            allowed = categories.split(",") if categories else None
            pins = active_pins(allowed_subcategories=allowed, rating_threshold=threshold)

            pin_ids = [p.id for p in pins if p.id is not None]
            vote_counts_map = vote_counts_for_pins(pin_ids)
            comments_map = comments_for_pins(pin_ids)
            unique_user_ids = {p.user_id for p in pins if p.user_id}
            active_authors_set = active_authors_recently(unique_user_ids)

            authors_cache: dict[str, dict] = {}

            if unique_user_ids:
                if LOCAL_MODE and not os.getenv("DATABASE_URL"):
                    for user_id in unique_user_ids:
                        authors_cache[user_id] = _build_author_preview(user_id)
                else:
                    from sqlalchemy import func, select

                    now_iso = datetime.now(timezone.utc)
                    with session_scope() as session:
                        profile_stmt = select(
                            profiles_table.c.nickname,
                            profiles_table.c.age,
                            profiles_table.c.gender,
                            profiles_table.c.avatar_path,
                            profiles_table.c.reputation_points,
                            profiles_table.c.level_up_pending,
                            profiles_table.c.is_verified,
                            profiles_table.c.created_at,
                            profiles_table.c.updated_at,
                        ).where(profiles_table.c.nickname.in_(unique_user_ids))
                        profile_rows = session.execute(profile_stmt).mappings().all()

                        rating_stmt = (
                            select(
                                pins_table.c.user_id,
                                func.coalesce(func.sum(pins_table.c.rating), 0).label("rating_total"),
                            )
                            .where(
                                pins_table.c.user_id.in_(unique_user_ids),
                                (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
                            )
                            .group_by(pins_table.c.user_id)
                        )
                        rating_rows = session.execute(rating_stmt).mappings().all()

                    rating_map = {
                        row["user_id"]: int(row.get("rating_total") or 0) for row in rating_rows
                    }

                    for user_id in unique_user_ids:
                        authors_cache[user_id] = {
                            "nickname": user_id,
                            "age": None,
                            "gender": None,
                            "avatar_url": None,
                            "rating_total": rating_map.get(user_id, 0),
                            "reputation_points": 0,
                            "reputation_level": 0,
                            "level_up_pending": False,
                            "is_verified": False,
                        }

                    for row in profile_rows:
                        nickname = row.get("nickname")
                        if not nickname:
                            continue
                        base = authors_cache.get(nickname)
                        if base is None:
                            base = {
                                "nickname": nickname,
                                "age": None,
                                "gender": None,
                                "avatar_url": None,
                                "rating_total": rating_map.get(nickname, 0),
                                "reputation_points": 0,
                                "reputation_level": 0,
                                "level_up_pending": False,
                                "is_verified": False,
                            }
                            authors_cache[nickname] = base

                        profile_dict = dict(row)
                        points = _clamp_points(profile_dict.get("reputation_points", 0))
                        base["reputation_points"] = points
                        base["reputation_level"] = calculate_reputation_level(points)
                        base["level_up_pending"] = bool(profile_dict.get("level_up_pending") or False)
                        base["is_verified"] = bool(profile_dict.get("is_verified") or False)

                        serialized = _serialize_profile(profile_dict)
                        if serialized:
                            base["age"] = serialized.get("age")
                            base["gender"] = serialized.get("gender")
                            base["avatar_url"] = serialized.get("avatar_url")
            
            response_payload = []
            for pin in pins:
                counts = vote_counts_map.get(pin.id, (0, 0))
                pin._preloaded_comments = comments_map.get(pin.id, [])
                payload = pin.to_dict(vote_counts=counts)
                user_id = pin.user_id
                if user_id:
                    author = authors_cache.get(user_id)
                    if author is None:
                        author = {
                            "nickname": user_id,
                            "age": None,
                            "gender": None,
                            "avatar_url": None,
                            "rating_total": 0,
                            "reputation_points": 0,
                            "reputation_level": 0,
                            "level_up_pending": False,
                            "is_verified": False,
                        }
                        authors_cache[user_id] = author
                    payload["author"] = {
                        "nickname": author.get("nickname") or user_id,
                        "avatar_url": author.get("avatar_url"),
                        "rating_total": author.get("rating_total"),
                        "reputation_points": author.get("reputation_points"),
                        "reputation_level": author.get("reputation_level"),
                        "level_up_pending": author.get("level_up_pending"),
                        "is_verified": author.get("is_verified"),
                        "is_active_recently": user_id in active_authors_set,
                        "age": author.get("age"),
                        "gender": author.get("gender"),
                        "followers_count": author.get("followers_count", 0),
                    }
                else:
                    payload["author"] = None
                response_payload.append(payload)
            response = jsonify(response_payload)
            response.headers["Cache-Control"] = "private, max-age=15"
            return response

        payload = request.get_json()
        if not payload:
            abort(400)
        category = payload.get("category") or payload.get("category_slug")
        subcategory = payload.get("subcategory_slug")
        nickname = payload.get("nickname")
        description = payload.get("description")
        lat = payload.get("lat")
        lng = payload.get("lng")
        contact = payload.get("contact")
        user = current_user_payload()
        if not all((category, subcategory, nickname, description, lat, lng)):
            abort(400)
        if not user:
            return jsonify({"message": "Нужно войти в аккаунт, чтобы создавать метки."}), 401
        user_id = user["nickname"]
        total_pins = count_active_pins_for_user(user_id)
        if total_pins >= USER_MARKER_LIMIT:
            response = jsonify({"message": USER_LIMIT_MESSAGE})
            response.status_code = 429
            return response
        adjust_user_reputation(user_id, +1)
        pin = create_pin(
            category=category,
            category_slug=payload.get("category_slug") or category,
            subcategory_slug=subcategory,
            nickname=nickname,
            description=description,
            lat=float(lat),
            lng=float(lng),
            contact=contact,
            user_id=user_id,
        )
        if not pin:
            abort(500)
        return jsonify(pin.to_dict())

    @app.route("/api/pins/<int:pin_id>", methods=["GET"])
    def fetch_pin(pin_id: int) -> tuple[dict, int]:
        pin = get_pin_by_id(pin_id)
        if not pin:
            abort(404)
        payload = pin.to_dict()
        user_id = pin.user_id
        if user_id:
            author = _build_user_state(user_id)
            payload["author"] = {
                "nickname": author.get("nickname") or user_id,
                "avatar_url": author.get("avatar_url"),
                "rating_total": author.get("rating_total"),
                "reputation_points": author.get("reputation_points"),
                "reputation_level": author.get("reputation_level"),
                "level_up_pending": author.get("level_up_pending"),
                "is_verified": author.get("is_verified"),
                "is_active_recently": is_author_active_recently(user_id),
                "age": author.get("age"),
                "gender": author.get("gender"),
                "followers_count": author.get("followers_count", 0),
            }
        else:
            payload["author"] = None
        return jsonify(payload)

    @app.route("/api/authors/<path:nickname>", methods=["GET"])
    def get_author(nickname: str) -> tuple[dict, int]:
        normalized = (nickname or "").strip()
        if not normalized:
            return {"message": "Никнейм не указан."}, 400
        user = get_user_by_nickname(normalized)
        if not user:
            return {"message": "Автор не найден."}, 404
        author_state = _build_user_state(user.nickname)
        return {"author": author_state}, 200

    def _require_authenticated_user():
        user = current_user_payload()
        if not user:
            abort(401, description="Нужно войти в аккаунт.")
        return user

    def _serialize_message_row(row: dict) -> dict:
        created_at = row.get("created_at")
        if isinstance(created_at, datetime):
            created_at = created_at.isoformat()
        return {
            "id": row.get("id"),
            "sender": row.get("sender_id"),
            "receiver": row.get("receiver_id"),
            "content": row.get("content"),
            "created_at": created_at,
            "is_read": bool(row.get("is_read")),
        }

    def _parse_message_timestamp(value) -> datetime | None:
        if isinstance(value, datetime):
            return value
        if isinstance(value, str) and value:
            iso_value = value
            if iso_value.endswith("Z"):
                iso_value = f"{iso_value[:-1]}+00:00"
            try:
                return datetime.fromisoformat(iso_value)
            except ValueError:
                pass
        return None

    def _normalize_message_timestamp(value) -> datetime | None:
        parsed = _parse_message_timestamp(value)
        if not parsed:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def _build_dialogs_from_rows(rows: list[dict], curr_nick: str) -> list[dict]:
        dialogs: dict[str, dict] = {}
        unread_counts: dict[str, int] = defaultdict(int)
        for row in rows:
            sender_raw = str(row.get("sender_id") or "").strip()
            receiver_raw = str(row.get("receiver_id") or "").strip()
            sender = sender_raw.lower()
            receiver = receiver_raw.lower()
            if not sender and not receiver:
                continue
            partner_key = ""
            partner_label = ""
            if sender == curr_nick and receiver:
                partner_key = receiver
                partner_label = receiver_raw
            elif receiver == curr_nick and sender:
                partner_key = sender
                partner_label = sender_raw
            if not partner_key:
                continue
            timestamp = _normalize_message_timestamp(row.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)
            entry = dialogs.get(partner_key)
            if not entry or timestamp > entry["_timestamp"]:
                dialogs[partner_key] = {
                    "interlocutor": partner_label,
                    "last_message": row.get("content") or "",
                    "created_at": timestamp.isoformat(),
                    "_timestamp": timestamp,
                    "_partner_key": partner_key,
                }
            is_read = row.get("is_read")
            if receiver == curr_nick and not bool(is_read):
                unread_counts[partner_key] += 1
        sorted_entries = sorted(dialogs.values(), key=lambda data: data["_timestamp"], reverse=True)
        results = []
        for entry in sorted_entries:
            results.append(
                {
                    "interlocutor": entry["interlocutor"],
                    "last_message": entry["last_message"],
                    "created_at": entry["created_at"],
                    "unread_count": unread_counts.get(entry["_partner_key"], 0),
                }
            )
        return results

    @app.route("/api/messages/<path:target_nickname>", methods=["GET"])
    def fetch_messages(target_nickname: str) -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"error": "Unauthorized"}, 401
        curr_nick = nickname.lower()
        target = (target_nickname or "").strip().lower()
        if not target:
            return {"messages": []}, 200
        if LOCAL_MODE and not os.getenv("DATABASE_URL"):
            store = _LOCAL_MESSAGES_STORE
            if not store:
                return {"messages": []}, 200
            data = store.snapshot()
            normalized = []
            for message in data.get("messages", []):
                sender_id = str(message.get("sender_id") or "").lower()
                receiver_id = str(message.get("receiver_id") or "").lower()
                if (
                    sender_id == curr_nick and receiver_id == target
                ) or (
                    sender_id == target and receiver_id == curr_nick
                ):
                    normalized.append(message)
            return {"messages": normalized}, 200

        from sqlalchemy import asc, and_, or_, select

        stmt = (
            select(
                messages_table.c.id,
                messages_table.c.sender_id,
                messages_table.c.receiver_id,
                messages_table.c.content,
                messages_table.c.created_at,
                messages_table.c.is_read,
            )
            .where(
                or_(
                    and_(
                        messages_table.c.sender_id == curr_nick,
                        messages_table.c.receiver_id == target,
                    ),
                    and_(
                        messages_table.c.sender_id == target,
                        messages_table.c.receiver_id == curr_nick,
                    ),
                )
            )
            .order_by(asc(messages_table.c.created_at))
        )
        with session_scope() as db_session:
            rows = db_session.execute(stmt).mappings().all()
        messages = [_serialize_message_row(dict(row)) for row in rows]
        return {"messages": messages}, 200

    @app.route("/api/messages/send", methods=["POST"])
    def send_message() -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"error": "Unauthorized"}, 401
        curr_nick = nickname.lower()
        payload = request.get_json(silent=True) or {}
        receiver = str(payload.get("receiver") or "").strip().lower()
        content = str(payload.get("content") or "").strip()
        if not receiver or not content:
            return {"error": "Invalid data"}, 400

        if LOCAL_MODE and not os.getenv("DATABASE_URL"):
            store = _LOCAL_MESSAGES_STORE
            if not store:
                return {"error": "Storage unavailable"}, 500
            store_data = store.snapshot()
            new_id = int(store_data.get("last_id", 0)) + 1
            new_msg = {
                "id": new_id,
                "sender_id": curr_nick,
                "receiver_id": receiver,
                "content": content,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "is_read": 0,
            }
            store_data.setdefault("messages", []).append(new_msg)
            store_data["last_id"] = new_id
            store.persist(store_data)

            emit_payload = {
                "id": new_id,
                "sender": curr_nick,
                "receiver": receiver,
                "content": content,
                "created_at": new_msg["created_at"],
                "is_read": False,
            }
            socketio.emit('new_message', {'message': emit_payload}, room=f"user_{receiver}")
            socketio.emit('new_message', {'message': emit_payload}, room=f"user_{curr_nick}")
            return {"message": new_msg}, 200

        from sqlalchemy import insert

        timestamp = datetime.now(timezone.utc)
        insert_stmt = (
            insert(messages_table)
            .values(
                sender_id=curr_nick,
                receiver_id=receiver,
                content=content,
                created_at=timestamp,
                is_read=0,
            )
            .returning(
                messages_table.c.id,
                messages_table.c.sender_id,
                messages_table.c.receiver_id,
                messages_table.c.content,
                messages_table.c.created_at,
                messages_table.c.is_read,
            )
        )
        with session_scope() as db_session:
            row = db_session.execute(insert_stmt).mappings().one()
        msg_payload = _serialize_message_row(dict(row))
        socketio.emit('new_message', {'message': msg_payload}, room=f"user_{receiver}")
        socketio.emit('new_message', {'message': msg_payload}, room=f"user_{curr_nick}")
        return {"message": msg_payload}, 200

    @app.route("/api/messages/read", methods=["POST"])
    def mark_messages_read() -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"error": "Unauthorized"}, 401
        curr_nick = nickname.lower()
        payload = request.get_json(silent=True) or {}
        partner = str(payload.get("partner") or payload.get("sender") or "").strip().lower()
        if not partner:
            return {"error": "Invalid partner"}, 400
        updated = 0
        if LOCAL_MODE and not os.getenv("DATABASE_URL"):
            store = _LOCAL_MESSAGES_STORE
            if not store:
                return {"error": "Storage unavailable"}, 500
            data = store.snapshot()
            messages = data.setdefault("messages", [])
            for message in messages:
                sender = str(message.get("sender_id") or "").lower()
                receiver = str(message.get("receiver_id") or "").lower()
                if (
                    sender == partner and
                    receiver == curr_nick and
                    not bool(message.get("is_read"))
                ):
                    message["is_read"] = 1
                    updated += 1
            store.persist(data)
            if updated > 0:
                socketio.emit('messages_read', {'reader': curr_nick}, room=f"user_{partner}")
            return {"updated": updated}, 200
        from sqlalchemy import update

        stmt = (
            update(messages_table)
            .where(
                messages_table.c.receiver_id == curr_nick,
                messages_table.c.sender_id == partner,
                messages_table.c.is_read == 0,
            )
            .values(is_read=1)
        )
        with session_scope() as db_session:
            result = db_session.execute(stmt)
            updated = result.rowcount or 0
        if updated > 0:
            socketio.emit('messages_read', {'reader': curr_nick}, room=f"user_{partner}")
        return {"updated": updated}, 200

    @app.route("/api/messages/dialogs/<path:nickname>", methods=["GET", "DELETE"])
    def fetch_or_delete_dialog(nickname: str) -> tuple[dict, int]:
        current = session.get("user_nickname")
        if not current:
            return {"error": "Unauthorized"}, 401
        curr_nick = current.lower()
        target = (nickname or "").strip().lower()
        if not target:
            return {"error": "Invalid target"}, 400

        if request.method == "DELETE":
            if LOCAL_MODE and not os.getenv("DATABASE_URL"):
                store = _LOCAL_MESSAGES_STORE
                if not store:
                    return {"error": "Storage unavailable"}, 500
                data = store.snapshot()
                data["messages"] = [msg for msg in data.get("messages", []) if not (
                    (str(msg.get("sender_id") or "").lower() == curr_nick and str(msg.get("receiver_id") or "").lower() == target) or
                    (str(msg.get("sender_id") or "").lower() == target and str(msg.get("receiver_id") or "").lower() == curr_nick)
                )]
                store.persist(data)
                return {"status": "success"}, 200
            from sqlalchemy import delete, and_, or_
            stmt = delete(messages_table).where(
                or_(
                    and_(
                        messages_table.c.sender_id == curr_nick,
                        messages_table.c.receiver_id == target,
                    ),
                    and_(
                        messages_table.c.sender_id == target,
                        messages_table.c.receiver_id == curr_nick,
                    ),
                )
            )
            with session_scope() as db_session:
                db_session.execute(stmt)
            return {"status": "success"}, 200

        target = target or curr_nick
        from sqlalchemy import asc, and_, or_, select
        stmt = (
            select(
                messages_table.c.id,
                messages_table.c.sender_id,
                messages_table.c.receiver_id,
                messages_table.c.content,
                messages_table.c.created_at,
                messages_table.c.is_read,
            )
            .where(
                or_(
                    and_(
                        messages_table.c.sender_id == curr_nick,
                        messages_table.c.receiver_id == target,
                    ),
                    and_(
                        messages_table.c.sender_id == target,
                        messages_table.c.receiver_id == curr_nick,
                    ),
                )
            )
            .order_by(asc(messages_table.c.created_at))
        )
        with session_scope() as db_session:
            rows = db_session.execute(stmt).mappings().all()
        messages = [_serialize_message_row(dict(row)) for row in rows]
        return {"messages": messages}, 200

    @app.route("/api/messages/dialogs", methods=["GET"])
    def fetch_dialogs() -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"error": "Unauthorized"}, 401
        curr_nick = nickname.lower()

        if LOCAL_MODE and not os.getenv("DATABASE_URL"):
            store = _LOCAL_MESSAGES_STORE
            if not store:
                return {"dialogs": []}, 200
            data = store.snapshot()
            rows = []
            for message in data.get("messages", []):
                rows.append(
                    {
                        "sender_id": message.get("sender_id"),
                        "receiver_id": message.get("receiver_id"),
                        "content": message.get("content"),
                        "created_at": message.get("created_at"),
                        "is_read": message.get("is_read"),
                    }
                )
            dialogs = _build_dialogs_from_rows(rows, curr_nick)
        else:
            from sqlalchemy import or_, select

            stmt = (
                select(
                    messages_table.c.id,
                    messages_table.c.sender_id,
                    messages_table.c.receiver_id,
                    messages_table.c.content,
                    messages_table.c.created_at,
                    messages_table.c.is_read,
                )
                .where(
                    or_(
                        messages_table.c.sender_id == curr_nick,
                        messages_table.c.receiver_id == curr_nick,
                    )
                )
            )
            with session_scope() as db_session:
                rows = db_session.execute(stmt).mappings().all()
            dialogs = _build_dialogs_from_rows(rows, curr_nick)

        # --- Обогащаем диалоги ссылками на аватары ---
        unique_nicks = {d["interlocutor"].lower() for d in dialogs if d.get("interlocutor")}
        avatars_map = {}
        if unique_nicks:
            if LOCAL_MODE and not os.getenv("DATABASE_URL"):
                for nick in unique_nicks:
                    preview = _build_author_preview(nick)
                    avatars_map[nick] = preview.get("avatar_url")
            else:
                from sqlalchemy import select, func
                with session_scope() as db_session:
                    prof_stmt = select(profiles_table.c.nickname, profiles_table.c.avatar_path).where(
                        func.lower(profiles_table.c.nickname).in_(unique_nicks)
                    )
                    db_rows = db_session.execute(prof_stmt).mappings().all()
                    for row in db_rows:
                        nick_key = row["nickname"].lower()
                        ser = _serialize_profile(dict(row))
                        avatars_map[nick_key] = ser.get("avatar_url") if ser else None

        for d in dialogs:
            interlocutor = d.get("interlocutor") or ''
            d["avatar_url"] = avatars_map.get(interlocutor.lower())

        return {"dialogs": dialogs}, 200

    @app.route("/add_comment", methods=["POST"])
    def add_comment_route():
        user = _require_authenticated_user()
        payload = request.get_json(force=True, silent=True) or {}
        marker_id = payload.get("marker_id")
        text = payload.get("text", "")
        if not isinstance(marker_id, int):
            abort(400, description="Некорректный идентификатор метки.")
        if not text or not str(text).strip():
            abort(400, description="Комментарий не может быть пустым.")
        comments = add_comment(marker_id, user["nickname"], text)
        if comments is None:
            abort(404, description="Метка не найдена или устарела.")
        socketio.emit('comments_updated', {'marker_id': marker_id, 'comments': comments}, room=str(marker_id))
        return jsonify({"status": "ok", "comments": comments}), 200

    @app.route("/delete_comment", methods=["DELETE"])
    def delete_comment_route():
        user = _require_authenticated_user()
        payload = request.get_json(force=True, silent=True) or {}
        marker_id = payload.get("marker_id")
        comment_id = payload.get("comment_id")
        if not isinstance(marker_id, int) or not comment_id:
            abort(400, description="Неверные параметры удаления.")
        status, comments = delete_comment(marker_id, user["nickname"], str(comment_id))
        if status == "pin_not_found":
            abort(404, description="Метка не найдена или устарела.")
        if status == "not_found":
            abort(404, description="Комментарий не найден.")
        if status == "forbidden":
            abort(403, description="Можно удалить только свой комментарий.")
        socketio.emit('comments_updated', {'marker_id': marker_id, 'comments': comments or []}, room=str(marker_id))
        return jsonify({"comments": comments or []})

    @app.route("/get_comments", methods=["GET"])
    def get_comments_route():
        marker_id = request.args.get("marker_id", type=int)
        if marker_id is None:
            abort(400, description="Некорректный идентификатор метки.")
        return jsonify({"comments": comments_for_pins([marker_id]).get(marker_id, [])})

    @app.route("/api/pins/<int:pin_id>", methods=["DELETE"])
    def delete_pin_route(pin_id: int) -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return jsonify({"message": "Нужно войти в аккаунт, чтобы удалять метки."}), 401
        user_id = nickname
        owner = get_pin_owner(pin_id)
        if owner is None:
            abort(404)
        if owner != user_id:
            abort(403)
        deleted = delete_pin(pin_id, user_id)
        if not deleted:
            abort(500)
        return jsonify({"deleted": True})

    @app.route("/api/pins/<int:pin_id>/vote", methods=["POST"])
    def vote(pin_id: int) -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"message": "Нужно войти в аккаунт чтобы голосовать."}, 401
        payload = request.get_json(silent=True) or {}
        def parse_vote(value) -> int | None:
            try:
                candidate = int(value)
            except (TypeError, ValueError):
                return None
            return candidate if candidate in (-1, 0, 1) else None
        vote_value = parse_vote(payload.get("vote"))
        if vote_value is None:
            vote_value = parse_vote(payload.get("delta"))
        if vote_value is None:
            vote_value = 1
        result = record_vote(pin_id, nickname, vote_value)
        if not result:
            abort(404)
        response_payload = {
            "pin_rating": result["pin_rating"],
            "vote_value": result["vote_value"],
            "pin_owner": result["pin_owner"],
            "likes_count": result.get("likes_count"),
            "dislikes_count": result.get("dislikes_count"),
        }
        if result.get("reputation_delta") and result["pin_owner"]:
            adjust_user_reputation(result["pin_owner"], result["reputation_delta"], trigger_level_up=True)
        if result.get("profile_rating") is not None and result["pin_owner"] == nickname:
            response_payload["profile_rating"] = result["profile_rating"]
        return jsonify(response_payload)

    @app.route("/api/subscriptions", methods=["GET", "POST", "DELETE"])
    def manage_subscriptions() -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"message": "Нужно войти в аккаунт."}, 401
        if request.method == "GET":
            payload = []
            try:
                payload = get_user_subscriptions(nickname)
            except Exception:  # pragma: no cover
                payload = []
            subscriptions_payload = []
            unique_nicknames = {n.lower() for n in payload if n}

            active_pins_counts = count_active_pins_for_users(list(unique_nicknames))

            if LOCAL_MODE and not os.getenv("DATABASE_URL"):
                for nick in payload:
                    if not nick:
                        continue
                    try:
                        author_state = _build_user_state(nick)
                    except Exception:
                        continue
                    pin_count = active_pins_counts.get(nick.lower(), 0)
                    subscriptions_payload.append(
                        {
                            "nickname": author_state.get("nickname"),
                            "avatar_url": author_state.get("avatar_url"),
                            "reputation_level": author_state.get("reputation_level", 1),
                            "active_pins_count": pin_count,
                        }
                    )
                return {"subscriptions": subscriptions_payload}, 200

            profile_map: dict[str, dict] = {}
            if unique_nicknames:
                from sqlalchemy import select, func

                with session_scope() as db_session:
                    profile_stmt = select(
                        profiles_table.c.nickname,
                        profiles_table.c.avatar_path,
                        profiles_table.c.reputation_points,
                    ).where(func.lower(profiles_table.c.nickname).in_(unique_nicknames))
                    profile_rows = db_session.execute(profile_stmt).mappings().all()
                for row in profile_rows:
                    nickname_key = row.get("nickname")
                    if not nickname_key:
                        continue
                    profile_map[nickname_key.lower()] = dict(row)
            for nick in payload:
                if not nick:
                    continue
                serialized = None
                profile_dict = profile_map.get(nick.lower())
                if profile_dict:
                    serialized = _serialize_profile(profile_dict)
                points = profile_dict.get("reputation_points", 0) if profile_dict else 0
                rep_level = calculate_reputation_level(points)
                pin_count = active_pins_counts.get(nick.lower(), 0)
                subscriptions_payload.append(
                    {
                        "nickname": nick,
                        "avatar_url": serialized.get("avatar_url") if serialized else None,
                        "reputation_level": rep_level,
                        "active_pins_count": pin_count,
                    }
                )
            return {"subscriptions": subscriptions_payload}, 200
        data = request.get_json(silent=True) or {}
        author = str(data.get("author_nickname") or data.get("author") or "").strip()
        if not author:
            return {"message": "Никнейм автора не указан."}, 400
        if request.method == "POST":
            add_user_subscription(nickname, author)
            return {"message": "Подписка добавлена."}, 200
        return {"message": "Неверный метод."}, 405

    @app.route("/api/subscriptions/<path:author_nickname>", methods=["DELETE"])
    def delete_subscription(author_nickname: str) -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"message": "Нужно войти в аккаунт."}, 401
        remove_user_subscription(nickname, author_nickname)
        return {"message": "Подписка удалена."}, 200

    @app.route("/api/user/level-up-acknowledged", methods=["POST"])
    def level_up_ack() -> tuple[dict, int]:
        user = current_user_payload()
        if not user:
            return {"message": "Нужно войти в аккаунт."}, 401
        set_level_up_pending(user["nickname"], False)
        return {"ok": True}, 200

    @app.route("/api/user/votes", methods=["GET"])
    def user_votes_route() -> tuple[dict, int]:
        nickname = session.get("user_nickname")
        if not nickname:
            return {"votes": {}}, 200
        raw_ids = request.args.get("pins", "")
        pin_ids: list[int] = []
        for chunk in raw_ids.split(","):
            try:
                parsed = int(chunk)
            except (TypeError, ValueError):
                continue
            if parsed > 0:
                pin_ids.append(parsed)
        votes = user_votes_for_pins(nickname, pin_ids)
        return {"votes": votes}, 200

    @app.route("/pin/<token>")
    def share_pin(token: str) -> str:
        pins = active_pins()
        current_user = current_user_payload()
        target = next((pin for pin in pins if pin.shared_token == token), None)
        if not target:
            abort(404)
        share_meta = {
            "title": f"{target.nickname} — {target.description[:30]}",
            "description": target.description,
            "image": SHARING_META["default_image"],
            "url": url_for("share_pin", token=token, _external=True),
        }
        bootstrap_payload = {
            "defaults": MAP_DEFAULTS,
            "highlight_pin": target.id,
            "share_meta": share_meta,
            "current_user": current_user,
        }
        bootstrap_json = json.dumps(bootstrap_payload, ensure_ascii=False)
        return render_template(
            "index.html",
            categories=CATEGORY_DEFINITIONS,
            defaults=MAP_DEFAULTS,
            highlight_pin=target.id,
            share_meta=share_meta,
            bootstrap_json=bootstrap_json,
            bootstrap_payload=bootstrap_payload,
            current_user=current_user,
        )

    @app.route("/favicon.ico")
    def favicon() -> redirect:
        return redirect(url_for("static", filename="img/favicon.ico"))

    @app.route("/admin/fix-db-nicknames-secret-99")
    def fix_db_nicknames() -> tuple[str, int]:
        from sqlalchemy import delete, func, select, text, update
        from database import profiles_table, session_scope, user_subscriptions_table, users_table

        def _find_case_conflicts(session):
            normalized_rows = session.execute(
                select(
                    func.lower(users_table.c.nickname).label("normalized"),
                    func.array_agg(users_table.c.nickname).label("nicknames"),
                )
                .group_by(func.lower(users_table.c.nickname))
                .having(func.count() > 1)
            ).all()
            duplicates = []
            for row in normalized_rows:
                lowered = str(row.normalized or "").strip()
                if not lowered:
                    continue
                nicknames = row.nicknames or []
                keep_target = lowered
                if keep_target not in nicknames and nicknames:
                    keep_target = nicknames[0]
                duplicates.extend(nick for nick in nicknames if nick != keep_target)
            return duplicates

        with session_scope() as session:
            try:
                session.execute(
                    text(
                        "DELETE FROM user_subscriptions "
                        "WHERE author_id NOT IN (SELECT nickname FROM users) "
                        "OR follower_id NOT IN (SELECT nickname FROM users)"
                    )
                )
                session.execute(
                    text(
                        "DELETE FROM user_subscriptions "
                        "WHERE author_id IN ('a', 'A') OR follower_id IN ('a', 'A')"
                    )
                )
                session.execute(text("DELETE FROM user_profiles WHERE nickname IN ('a', 'A')"))
                session.execute(text("DELETE FROM users WHERE nickname IN ('a', 'A')"))

                conflicting_nicknames = _find_case_conflicts(session)
                if conflicting_nicknames:
                    session.execute(
                        delete(user_subscriptions_table).where(
                            user_subscriptions_table.c.author_id.in_(conflicting_nicknames)
                            | user_subscriptions_table.c.follower_id.in_(conflicting_nicknames)
                        )
                    )
                    session.execute(
                        delete(profiles_table).where(profiles_table.c.nickname.in_(conflicting_nicknames))
                    )
                    session.execute(
                        delete(users_table).where(users_table.c.nickname.in_(conflicting_nicknames))
                    )

                session.execute(
                    update(user_subscriptions_table).values(
                        follower_id=func.lower(user_subscriptions_table.c.follower_id),
                        author_id=func.lower(user_subscriptions_table.c.author_id),
                    )
                )
                session.execute(update(users_table).values(nickname=func.lower(users_table.c.nickname)))
                session.execute(update(profiles_table).values(nickname=func.lower(profiles_table.c.nickname)))

                session.commit()
            except Exception:
                session.rollback()
                raise

        return "База данных полностью очищена и синхронизирована!", 200

    @app.route("/health")
    def healthcheck() -> tuple[dict, int]:
        return {"status": "ok"}, 200

    return app


app = create_app()
app.config['SECRET_KEY'] = SECRET_KEY
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')


@socketio.on('join_pin')
def on_join_pin(data):
    pin_id = str(data.get('pin_id'))
    join_room(pin_id)


@socketio.on('get_comments')
def on_get_comments(data):
    pin_id = data.get('marker_id')
    if not pin_id:
        return
    try:
        pin_id = int(pin_id)
    except (TypeError, ValueError):
        return
    comments = comments_for_pins([pin_id]).get(pin_id, [])
    emit('load_comments', {'marker_id': pin_id, 'comments': comments})


@socketio.on('leave_pin')
def on_leave_pin(data):
    pin_id = str(data.get('pin_id'))
    leave_room(pin_id)


@socketio.on('join_user_room')
def on_join_user_room(data):
    nickname = str(data.get('nickname') or '').strip().lower()
    if nickname:
        join_room(f"user_{nickname}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
