from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional


PROJECT_ROOT = Path(__file__).resolve().parent
DB_DIR = PROJECT_ROOT / "data"
DB_DIR.mkdir(exist_ok=True)
DATABASE_PATH = DB_DIR / "live_map.db"
DATABASE_KEY = os.environ.get("LIVE_MAP_DB_KEY", "dev-live-map-key")
DEFAULT_SQLITE_URL = f"sqlite:///{DATABASE_PATH}"
DATABASE_URL = os.environ.get("DATABASE_URL", DEFAULT_SQLITE_URL)
LOCAL_PINS_PATH = DB_DIR / "pins.json"

MAP_DEFAULTS = {
    "zoom": 13,
    "lat": 55.7558,
    "lng": 37.6176,
}

BASE_TTL_SECONDS: Dict[str, Optional[int]] = {
    "landmarks.default": 30 * 24 * 3600,
    "moto.urgent": 2 * 3600,
    "moto.ride": 6 * 3600,
    "sport.table_tennis": 4 * 3600,
    "sport.badminton": 4 * 3600,
    "sport.cycling": 4 * 3600,
    "fishing.spinning": 12 * 3600,
    "fishing.feeder": 12 * 3600,
    "fishing.floating": 12 * 3600,
    "fishing.boat_ramp": None,
    "community.chat": 3 * 3600,
    "community.coffee": 3 * 3600,
    "community.dating": 3 * 3600,
    "museums.classic": 24 * 3600,
    "museums.modern": 24 * 3600,
    "food_drink.cafe": 6 * 3600,
    "food_drink.bar": 6 * 3600,
}

CATEGORY_DEFINITIONS: List[Dict[str, object]] = [
    {
        "slug": "community",
        "label": "Знакомства",
        "color": "#9B59B6",
        "icon": "💬",
        "subcategories": [
            {"slug": "community.chat", "label": "Чат", "ttl": BASE_TTL_SECONDS["community.chat"]},
            {"slug": "community.coffee", "label": "Кофе", "ttl": BASE_TTL_SECONDS["community.coffee"]},
            {"slug": "community.dating", "label": "Знакомство", "ttl": BASE_TTL_SECONDS["community.dating"]},
        ],
    },
    {
        "slug": "sport",
        "label": "Спорт",
        "color": "#2ECC71",
        "icon": "⚽",
        "subcategories": [
            {"slug": "sport.table_tennis", "label": "Настольный теннис", "ttl": BASE_TTL_SECONDS["sport.table_tennis"]},
            {"slug": "sport.badminton", "label": "Бадминтон", "ttl": BASE_TTL_SECONDS["sport.badminton"]},
            {"slug": "sport.cycling", "label": "Вело", "ttl": BASE_TTL_SECONDS["sport.cycling"]},
        ],
    },
    {
        "slug": "food_drink",
        "label": "Бары",
        "color": "#FF4500",
        "icon": "🍺",
        "subcategories": [
            {"slug": "food_drink.cafe", "label": "Кафе/Рестораны", "ttl": BASE_TTL_SECONDS["food_drink.cafe"]},
            {"slug": "food_drink.bar", "label": "Бары/Клубы", "ttl": BASE_TTL_SECONDS["food_drink.bar"]},
        ],
    },
    {
        "slug": "landmarks",
        "label": "Места",
        "color": "#006400",
        "icon": "🏰",
        "subcategories": [
            {
                "slug": "landmarks.architecture",
                "label": "Архитектурные объекты",
                "ttl": BASE_TTL_SECONDS["landmarks.default"],
            },
            {
                "slug": "landmarks.history",
                "label": "Исторические объекты",
                "ttl": BASE_TTL_SECONDS["landmarks.default"],
            },
            {
                "slug": "landmarks.nature",
                "label": "Природные объекты",
                "ttl": BASE_TTL_SECONDS["landmarks.default"],
            },
        ],
    },
    {
        "slug": "museums",
        "label": "Выставки",
        "color": "#CD7F32",
        "icon": "🏛️",
        "subcategories": [
            {"slug": "museums.classic", "label": "Классика", "ttl": BASE_TTL_SECONDS["museums.classic"]},
            {"slug": "museums.modern", "label": "Модерн", "ttl": BASE_TTL_SECONDS["museums.modern"]},
        ],
    },
    {
        "slug": "fishing",
        "label": "Рыбалка",
        "color": "#3498DB",
        "icon": "🎣",
        "subcategories": [
            {"slug": "fishing.spinning", "label": "Спиннинг", "ttl": BASE_TTL_SECONDS["fishing.spinning"]},
            {"slug": "fishing.feeder", "label": "Фидер", "ttl": BASE_TTL_SECONDS["fishing.feeder"]},
            {"slug": "fishing.floating", "label": "Поплавок", "ttl": BASE_TTL_SECONDS["fishing.floating"]},
            {"slug": "fishing.boat_ramp", "label": "Спуск лодок", "ttl": BASE_TTL_SECONDS["fishing.boat_ramp"]},
        ],
    },
    {
        "slug": "moto",
        "label": "Мото",
        "color": "#8B0000",
        "icon": "🏍️",
        "subcategories": [
            {"slug": "moto.urgent", "label": "ДТП / Срочная помощь", "ttl": BASE_TTL_SECONDS["moto.urgent"]},
            {"slug": "moto.ride", "label": "Покатушки / Сбор", "ttl": BASE_TTL_SECONDS["moto.ride"]},
        ],
    },
]

SHARING_META = {
    "site_name": "Живая карта интересов",
    "default_image": "https://example.com/static/img/og-default.png",
}


def is_local_mode() -> bool:
    """Определяем режим хранения данных (local/json vs sqlalchemy)."""
    app_mode = (os.environ.get("APP_MODE") or "").strip().lower()
    if app_mode:
        if app_mode == "local":
            return True
        if app_mode == "sqlalchemy":
            return False
        raise ValueError("APP_MODE должен быть 'local' или 'sqlalchemy'")

    db_url = (DATABASE_URL or "").lower()
    return "postgres" not in db_url


def ttl_for(subcategory_slug: str) -> Optional[int]:
    return BASE_TTL_SECONDS.get(subcategory_slug)


def colored_icon_for_category(slug: str) -> str:
    for group in CATEGORY_DEFINITIONS:
        if group["slug"] == slug:
            return group["color"]
    return "#ffffff"
