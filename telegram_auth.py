import hmac
import hashlib
import json
import time
from urllib.parse import unquote
from typing import Optional, Dict


def verify_init_data(init_data: str, bot_token: str, max_age_seconds: int = 86400) -> Optional[Dict[str, str]]:
    if not init_data or not bot_token:
        return None

    # Разбираем БЕЗ декодирования: значения должны остаться сырыми для проверки подписи
    raw_pairs = {}
    for chunk in init_data.split('&'):
        if '=' in chunk:
            key, value = chunk.split('=', 1)
            raw_pairs[key] = value

    received_hash = raw_pairs.pop('hash', None)
    raw_pairs.pop('signature', None)
    if not received_hash:
        return None

    # data_check_string строится из СЫРЫХ (не декодированных) значений
    data_check_string = '\n'.join(f"{k}={raw_pairs[k]}" for k in sorted(raw_pairs))

    clean_token = bot_token.strip()
    secret_key = hmac.new(b"WebAppData", clean_token.encode('utf-8'), hashlib.sha256).digest()
    computed_hash = hmac.new(secret_key, data_check_string.encode('utf-8'), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(computed_hash, received_hash):
        return None

    # Подпись верна — теперь декодируем значения для возврата
    decoded = {k: unquote(v) for k, v in raw_pairs.items()}

    auth_date = decoded.get('auth_date')
    if auth_date:
        try:
            if time.time() - int(auth_date) > max_age_seconds:
                return None
        except (ValueError, TypeError):
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
