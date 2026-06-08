import hmac
import hashlib
import json
import time
from typing import Dict, Optional


def verify_init_data(
    init_data: str, bot_token: str, max_age_seconds: int = 86_400
) -> Optional[Dict[str, str]]:
    """Проверка initData Telegram Mini App. Возвращает декодированные пары при успехе."""

    if not init_data or not bot_token:
        return None

    raw_pairs = {}
    for chunk in init_data.split("&"):
        if "=" not in chunk:
            continue
        key, value = chunk.split("=", 1)
        raw_pairs[key] = value

    received_hash = raw_pairs.pop("hash", None)
    if not received_hash:
        return None
    raw_pairs.pop("signature", None)

    data_check_string = "\n".join(f"{k}={raw_pairs[k]}" for k in sorted(raw_pairs))

    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    from urllib.parse import unquote
    decoded = {k: unquote(v) for k, v in raw_pairs.items()}

    auth_date = decoded.get("auth_date")
    if auth_date is not None:
        try:
            if time.time() - int(auth_date) > max_age_seconds:
                return None
        except (TypeError, ValueError):
            return None

    return decoded


def get_user_from_init_data(parsed: Dict[str, str]) -> Optional[Dict[str, object]]:
    """Возвращает разобранный JSON поля user из проверенного initData."""

    raw_user = parsed.get("user")
    if not raw_user:
        return None
    try:
        return json.loads(raw_user)
    except (TypeError, json.JSONDecodeError):
        return None
