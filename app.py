from __future__ import annotations

import json

from flask import Flask, abort, jsonify, redirect, render_template, request, url_for

from config import CATEGORY_DEFINITIONS, MAP_DEFAULTS, SHARING_META
from database import ensure_connection, init_schema
from models import (
    active_pins,
    adjust_rating,
    count_active_pins_for_user,
    create_pin,
    delete_pin,
    get_pin_owner,
)

USER_MARKER_LIMIT = 5
USER_LIMIT_MESSAGE = (
    'Вы достигли лимита в 5 меток. Пожалуйста, удалите старую или дождитесь её исчезновения.'
)


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")

    try:
        init_schema()
        ensure_connection()
    except Exception as exc:  # pragma: no cover - warm-up only
        app.logger.warning("Database warm-up skipped: %s", exc)

    @app.route("/")
    def index() -> str:
        highlight_pin = request.args.get("pin", type=int)
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
        )

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
        user_id = payload.get("liveMapUserId")
        if not all((category, subcategory, nickname, description, lat, lng)):
            abort(400)
        if not user_id:
            abort(400)
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

    @app.route("/api/pins/<int:pin_id>", methods=["DELETE"])
    def remove_pin(pin_id: int) -> tuple[dict, int]:
        payload = request.get_json()
        if not payload:
            abort(400)
        user_id = payload.get("liveMapUserId")
        if not user_id:
            abort(400)
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
        )

    @app.route("/favicon.ico")
    def favicon() -> redirect:
        return redirect(url_for("static", filename="img/favicon.ico"))

    @app.route("/health")
    def healthcheck() -> tuple[dict, int]:
        return {"status": "ok"}, 200

    return app


app = create_app()
