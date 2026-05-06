from __future__ import annotations

import os
from pathlib import Path
from typing import Dict, List, Optional

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dev dependency
    load_dotenv = None  # type: ignore[assignment]


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = Path(BASE_DIR)
if load_dotenv:
    load_dotenv(dotenv_path=PROJECT_ROOT / ".env", override=False)
def _parse_bool_env(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    return normalized in {"1", "true", "yes", "on"}
DB_DIR_PATH = os.path.join(BASE_DIR, "data")
os.makedirs(DB_DIR_PATH, exist_ok=True)
DB_DIR = Path(DB_DIR_PATH)
DATABASE_PATH = Path(BASE_DIR) / "database.db"
DATABASE_KEY = os.getenv("LIVE_MAP_DB_KEY", "dev-live-map-key")
SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY must be set via environment variable")
DEFAULT_SQLITE_URL = f"sqlite:///{DATABASE_PATH}"


def _normalize_database_url(raw_url: str | None) -> str | None:
    if not raw_url:
        return raw_url
    normalized = raw_url.strip()
    if normalized.startswith("postgres://"):
        return "postgresql://" + normalized[len("postgres://"):]
    return normalized


DATABASE_URL = _normalize_database_url(os.environ.get("DATABASE_URL") or DEFAULT_SQLITE_URL)
LOCAL_PINS_PATH = DB_DIR / "pins.json"
LOCAL_USERS_PATH = DB_DIR / "users.json"
LOCAL_PROFILES_PATH = DB_DIR / "profiles.json"

STATIC_DIR = PROJECT_ROOT / "static"
UPLOADS_DIR = STATIC_DIR / "uploads"
AVATAR_UPLOAD_DIR = UPLOADS_DIR / "avatars"
AVATAR_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

MAX_AVATAR_FILE_SIZE = int(os.environ.get("MAX_AVATAR_FILE_SIZE", 10 * 1024 * 1024))
ALLOWED_AVATAR_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
CLOUDINARY_FORCE_UPLOADS = _parse_bool_env(os.getenv("CLOUDINARY_FORCE_UPLOADS"))
_raw_cloudinary_url = (os.getenv("CLOUDINARY_URL") or "").strip()
CLOUDINARY_URL = _raw_cloudinary_url or None
CLOUDINARY_CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME")
CLOUDINARY_API_KEY = os.getenv("CLOUDINARY_API_KEY")
CLOUDINARY_API_SECRET = os.getenv("CLOUDINARY_API_SECRET")
CLOUDINARY_AVATAR_FOLDER = os.getenv("CLOUDINARY_AVATAR_FOLDER", "live_map/avatars")
CLOUDINARY_STORAGE_PREFIX = "cloudinary:"

CLOUDINARY_CREDENTIALS = {
    "cloud_name": CLOUDINARY_CLOUD_NAME,
    "api_key": CLOUDINARY_API_KEY,
    "api_secret": CLOUDINARY_API_SECRET,
}
CLOUDINARY_HAS_BASIC_CREDS = all(CLOUDINARY_CREDENTIALS.values())
CLOUDINARY_HAS_CREDENTIALS = bool(CLOUDINARY_URL or CLOUDINARY_HAS_BASIC_CREDS)
CLOUDINARY_ENABLED_OVERRIDE = _parse_bool_env(os.getenv("CLOUDINARY_ENABLED"))
CLOUDINARY_ENABLED = CLOUDINARY_FORCE_UPLOADS or CLOUDINARY_ENABLED_OVERRIDE or CLOUDINARY_HAS_CREDENTIALS

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
    "fishing.boat_ramp": 60 * 24 * 3600,
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
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>',
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
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>',
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
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8h1a4 4 0 0 1 0 8h-1"></path><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path><line x1="6" y1="1" x2="6" y2="4"></line><line x1="10" y1="1" x2="10" y2="4"></line><line x1="14" y1="1" x2="14" y2="4"></line></svg>',
        "subcategories": [
            {"slug": "food_drink.cafe", "label": "Кафе/Рестораны", "ttl": BASE_TTL_SECONDS["food_drink.cafe"]},
            {"slug": "food_drink.bar", "label": "Бары/Клубы", "ttl": BASE_TTL_SECONDS["food_drink.bar"]},
        ],
    },
    {
        "slug": "landmarks",
        "label": "Места",
        "color": "#006400",
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
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
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="20" width="20" height="2"></rect><rect x="2" y="2" width="20" height="4"></rect><path d="M6 6v14"></path><path d="M10 6v14"></path><path d="M14 6v14"></path><path d="M18 6v14"></path></svg>',
        "subcategories": [
            {"slug": "museums.classic", "label": "Классика", "ttl": BASE_TTL_SECONDS["museums.classic"]},
            {"slug": "museums.modern", "label": "Модерн", "ttl": BASE_TTL_SECONDS["museums.modern"]},
        ],
    },
    {
        "slug": "fishing",
        "label": "Рыбалка",
        "color": "#3498DB",
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12l-6-6c-4 0-8 3-10 6 2 3 6 6 10 6l6-6z"></path><polygon points="6 12 2 8 2 16 6 12"></polygon><circle cx="16" cy="11" r="1"></circle></svg>',
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
        "icon": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"></circle><circle cx="18.5" cy="17.5" r="3.5"></circle><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5V14l-3-3 4-3 2 3h2"></path></svg>',
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
