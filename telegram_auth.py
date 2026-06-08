import hmac
import hashlib
import json
import time
from typing import Dict, Optional
from urllib.parse import parse_qsl


def verify_init_data(
    init_data: str, bot_token: str, max_age_seconds: int = 86_400
) -> Optional[Dict[str, str]]:
    """Выполняет проверку initData от Telegram Mini App и возвращает проверенные пары."""

    if not init_data or not bot_token:
        return None

    try:
        pairs = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None

    received_hash = pairs.pop("hash", None)
    if not received_hash:
        return None

    pairs.pop("signature", None)

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(pairs.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    auth_date = pairs.get("auth_date")
    if auth_date is not None:
        try:
            if time.time() - int(auth_date) > max_age_seconds:
                return None
        except (TypeError, ValueError):
            return None

    return pairs


def get_user_from_init_data(parsed: Dict[str, str]) -> Optional[Dict[str, object]]:
    """Возвращает разобранный JSON поля user из проверенного initData."""

    raw_user = parsed.get("user")
    if not raw_user:
        return None
    try:
        return json.loads(raw_user)
    except (TypeError, json.JSONDecodeError):
        return None
