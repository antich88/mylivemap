# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for
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
    active_authors_recently,
    ensure_connection,
    init_schema,
    pins_table,
    profiles_table,
    session_scope,
)
from models import (
    active_pins,
    add_comment,
    count_active_pins_for_user,
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
        base = {"nickname": nickname, "age": None, "gender": None, "avatar_url": None}
        base["rating_total"] = get_user_rating_total(nickname)
        # reputation state
        reputation = get_reputation_state(nickname)
        base.update(reputation)
        try:
            profile = get_or_create_user_profile(nickname)
        except Exception as exc:  # pragma: no cover
            app.logger.exception("Failed to load profile for %s: %s", nickname, exc)
            base["profile"] = None
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
        else:
            base["profile"] = None
        try:
            base["subscriptions"] = get_user_subscriptions(nickname)
        except Exception:  # pragma: no cover
            base["subscriptions"] = []
        return base

    def _build_author_preview(nickname: str) -> dict:
        """Лёгкая версия профиля автора для попапа метки.
        Вытаскивает rating + profile одним запросом вместо 4 отдельных.
        Не тянет subscriptions (для попапа не нужны)."""

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

        if LOCAL_MODE:
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
            )
            secure_url = str(upload_result.get("secure_url") or "").strip()
            print(f"DEBUG CLOUDINARY SUCCESS: {secure_url}")
            if secure_url:
                return secure_url
            print("DEBUG CLOUDINARY WARNING: secure_url отсутствует, отклоняем запись")
            return None
        except Exception as exc:  # pragma: no cover
            print(f"DEBUG CLOUDINARY ERROR: {exc}")
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
            "description": "Живая карта интересов с категориями "
            " по Мото, Спорт, Рыбалка и Знакомства",
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
            app.logger.exception(
                "Nickname update failed for nickname=%s: %s",
                current_user["nickname"],
                exc,
            )
            return {"message": "Не удалось обновить имя. Попробуйте позже."}, 500

        try:
            reassign_user_id(current_user["nickname"], updated_user.nickname)
        except Exception as exc:  # pragma: no cover
            app.logger.exception(
                "Failed to propagate nickname change from %s to %s: %s",
                current_user["nickname"],
                updated_user.nickname,
                exc,
            )
            return {"message": "Не удалось применить новое имя во всех разделах."}, 500

        session["user_nickname"] = updated_user.nickname
        return {"user": _build_user_state(updated_user.nickname)}, 200

    @app.route("/logout", methods=["POST"])
    def logout_user() -> tuple[dict, int]:
        session.pop("user_nickname", None)
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
                app.logger.exception(
                    "Nickname update failed for nickname=%s: %s",
                    original_nickname,
                    exc,
                )
                return {"message": "Не удалось обновить имя. Попробуйте позже."}, 500

            try:
                reassign_user_id(original_nickname, updated_user.nickname)
            except Exception as exc:  # pragma: no cover
                app.logger.exception(
                    "Failed to propagate nickname change from %s to %s: %s",
                    original_nickname,
                    updated_user.nickname,
                    exc,
                )
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
            print("--- ATTEMPTING CLOUDINARY UPLOAD ---")
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

            # Батч-подсчёт голосов одним SQL-запросом для всех пинов сразу.
            # Устраняет N+1 (было 2N запросов в vote_counts_for_pin).
            pin_ids = [p.id for p in pins if p.id is not None]
            vote_counts_map = vote_counts_for_pins(pin_ids)

            # Батч-проверка "активен ли автор за последние 7 дней" — один SQL вместо N
            unique_user_ids = {p.user_id for p in pins if p.user_id}
            active_authors_set = active_authors_recently(unique_user_ids)

            authors_cache: dict[str, dict] = {}

            if unique_user_ids:
                if LOCAL_MODE:
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
            }
        else:
            payload["author"] = None
        print(f"pin fetch requested: pin_id={pin_id} rating={payload.get('rating')}", flush=True)
        print(f"DEBUG: Pin data sent to UI: pin_id={pin_id} rating={payload.get('rating')}", flush=True)
        print(f"ОТПРАВКА НА ФРОНТ: ID {pin_id}, Rating {pin.rating}", flush=True)
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

    def _pin_or_404(pin_id: int):
        pin = next((p for p in active_pins() if p.id == pin_id), None)
        if not pin:
            abort(404)
        return pin

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
        return jsonify({"comments": comments})

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
        return jsonify({"comments": comments or []})

    @app.route("/get_comments", methods=["GET"])
    def get_comments_route():
        marker_id = request.args.get("marker_id", type=int)
        if marker_id is None:
            abort(400, description="Некорректный идентификатор метки.")
        pin = get_pin_by_id(marker_id)
        if not pin:
            abort(404, description="Метка не найдена или устарела.")
        return jsonify({"comments": pin.comments})

    @app.route("/api/pins/<int:pin_id>", methods=["GET", "DELETE"])
    def manage_pin(pin_id: int) -> tuple[dict, int]:
        if request.method == "GET":
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
                    "age": author.get("age"),
                    "gender": author.get("gender"),
                }
            else:
                payload["author"] = None
            app.logger.info(
                "pin fetch requested: pin_id=%s rating=%s",
                pin_id,
                payload.get("rating"),
            )
            return jsonify(payload)

        user = current_user_payload()
        if not user:
            return jsonify({"message": "Нужно войти в аккаунт, чтобы удалять метки."}), 401
        user_id = user["nickname"]
        owner = get_pin_owner(pin_id)
        if owner is None:
            abort(404)
        if owner != user_id:
            abort(403)
        deleted = delete_pin(pin_id, user_id)
        if not deleted:
            abort(500)
        app.logger.info("pin delete requested: pin_id=%s user=%s", pin_id, user_id)
        return jsonify({"deleted": True})

    @app.route("/api/pins/<int:pin_id>/vote", methods=["POST"])
    def vote(pin_id: int) -> tuple[dict, int]:
        user = current_user_payload()
        if not user:
            app.logger.debug("vote denied: unauthenticated request for pin_id=%s", pin_id)
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
        result = record_vote(pin_id, user["nickname"], vote_value)
        if not result:
            abort(404)
        response_payload = {
            "pin_rating": result["pin_rating"],
            "vote_value": result["vote_value"],
            "pin_owner": result["pin_owner"],
            "likes_count": result.get("likes_count"),
            "dislikes_count": result.get("dislikes_count"),
        }
        # apply reputation delta to pin owner
        if result.get("reputation_delta") and result["pin_owner"]:
            adjust_user_reputation(result["pin_owner"], result["reputation_delta"], trigger_level_up=True)
        if result.get("profile_rating") is not None and result["pin_owner"] == user["nickname"]:
            response_payload["profile_rating"] = result["profile_rating"]
        app.logger.info(
            "vote recorded: pin_id=%s user=%s vote=%s rating=%s",
            pin_id,
            user["nickname"],
            response_payload["vote_value"],
            response_payload["pin_rating"],
        )
        return jsonify(response_payload)

    @app.route("/api/subscriptions", methods=["GET", "POST", "DELETE"])
    def manage_subscriptions() -> tuple[dict, int]:
        user = current_user_payload()
        if not user:
            return {"message": "Нужно войти в аккаунт."}, 401
        if request.method == "GET":
            payload = []
            try:
                payload = get_user_subscriptions(user["nickname"])
            except Exception:  # pragma: no cover
                payload = []
            subscriptions_payload = []
            for nickname in payload:
                try:
                    author_state = _build_user_state(nickname)
                except Exception:
                    continue
                subscriptions_payload.append(
                    {
                        "nickname": author_state.get("nickname"),
                        "avatar_url": author_state.get("avatar_url"),
                    }
                )
            return {"subscriptions": subscriptions_payload}, 200
        data = request.get_json(silent=True) or {}
        author = str(data.get("author_nickname") or data.get("author") or "").strip()
        if not author:
            return {"message": "Никнейм автора не указан."}, 400
        if request.method == "POST":
            add_user_subscription(user["nickname"], author)
            return {"message": "Подписка добавлена."}, 200
        return {"message": "Неверный метод."}, 405

    @app.route("/api/subscriptions/<path:author_nickname>", methods=["DELETE"])
    def delete_subscription(author_nickname: str) -> tuple[dict, int]:
        user = current_user_payload()
        if not user:
            return {"message": "Нужно войти в аккаунт."}, 401
        remove_user_subscription(user["nickname"], author_nickname)
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
        user = current_user_payload()
        if not user:
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
        votes = user_votes_for_pins(user["nickname"], pin_ids)
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

    @app.route("/health")
    def healthcheck() -> tuple[dict, int]:
        return {"status": "ok"}, 200

    return app


app = create_app()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
