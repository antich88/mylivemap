from __future__ import annotations

import json
import os

from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for

from auth_store import create_user, get_user_by_nickname, verify_user_credentials
from config import CATEGORY_DEFINITIONS, MAP_DEFAULTS, SECRET_KEY, SHARING_META
from database import ensure_connection, init_schema
from models import (
    active_pins,
    add_comment,
    adjust_rating,
    count_active_pins_for_user,
    create_pin,
    delete_comment,
    delete_pin,
    get_pin_by_id,
    get_pin_owner,
)

USER_MARKER_LIMIT = 5
USER_LIMIT_MESSAGE = (
    'Вы достигли лимита в 5 меток. Пожалуйста, удалите старую или дождитесь её исчезновения.'
)


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.secret_key = SECRET_KEY

    try:
        init_schema()
        ensure_connection()
    except Exception as exc:  # pragma: no cover - warm-up only
        app.logger.warning("Database warm-up skipped: %s", exc)

    def current_user_payload() -> dict | None:
        nickname = session.get("user_nickname")
        if not nickname:
            return None
        user = get_user_by_nickname(nickname)
        if not user:
            session.pop("user_nickname", None)
            return None
        return {"nickname": user.nickname}

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
        return {"user": {"nickname": user.nickname}}, 201

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
        return {"user": {"nickname": user.nickname}}, 200

    @app.route("/logout", methods=["POST"])
    def logout_user() -> tuple[dict, int]:
        session.pop("user_nickname", None)
        return {"ok": True}, 200

    @app.route("/me", methods=["GET"])
    def me() -> tuple[dict, int]:
        user = current_user_payload()
        return {"authenticated": bool(user), "user": user}, 200

    @app.route("/api/pins", methods=["GET", "POST"])
    def refresh_or_create_pin():
        if request.method == "GET":
            categories = request.args.get("subcategories")
            threshold = request.args.get("rating", default=-999, type=int)
            allowed = categories.split(",") if categories else None
            pins = active_pins(allowed_subcategories=allowed, rating_threshold=threshold)
            return jsonify([pin.to_dict() for pin in pins])

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

    @app.route("/api/pins/<int:pin_id>", methods=["DELETE"])
    def remove_pin(pin_id: int) -> tuple[dict, int]:
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
        return jsonify({"deleted": True})

    @app.route("/api/pins/<int:pin_id>/vote", methods=["POST"])
    def vote(pin_id: int) -> tuple[dict, int]:
        delta = request.json.get("delta", 1)
        rating = adjust_rating(pin_id, delta)
        if rating is None:
            abort(404)
        return jsonify({"rating": rating})

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
