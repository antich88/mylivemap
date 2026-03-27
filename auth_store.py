from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from werkzeug.security import check_password_hash, generate_password_hash

from config import LOCAL_USERS_PATH, is_local_mode
from database import session_scope, users_table


LOCAL_MODE = is_local_mode()
logger = logging.getLogger(__name__)


@dataclass
class AuthUser:
    id: int
    nickname: str
    password_hash: str
    created_at: datetime


class LocalUserStore:
    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self.ensure_storage()

    def ensure_storage(self) -> None:
        if not self.storage_path.exists():
            self.storage_path.write_text(
                json.dumps({"users": [], "last_id": 0}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def snapshot(self) -> Dict[str, Any]:
        self.ensure_storage()
        try:
            return json.loads(self.storage_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"users": [], "last_id": 0}

    def persist(self, payload: Dict[str, Any]) -> None:
        tmp_path = self.storage_path.with_suffix(".tmp")
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(self.storage_path)
        except Exception:
            logger.exception("Failed to persist users snapshot to %s", self.storage_path)
            raise


_LOCAL_STORE = LocalUserStore(LOCAL_USERS_PATH) if LOCAL_MODE else None


def _normalize_nickname(nickname: str) -> str:
    return (nickname or "").strip().lower()


def _local_record_to_user(record: Dict[str, Any]) -> AuthUser:
    created_at_raw = record.get("created_at")
    if isinstance(created_at_raw, datetime):
        created_at = created_at_raw
    elif isinstance(created_at_raw, str) and created_at_raw:
        created_at = datetime.fromisoformat(created_at_raw)
    else:
        created_at = datetime.now(timezone.utc)

    return AuthUser(
        id=int(record.get("id", 0)),
        nickname=str(record.get("nickname") or ""),
        password_hash=str(record.get("password_hash") or ""),
        created_at=created_at,
    )


def get_user_by_nickname(nickname: str) -> Optional[AuthUser]:
    normalized = _normalize_nickname(nickname)
    if not normalized:
        return None

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        for record in snapshot.get("users", []):
            if str(record.get("nickname") or "") == normalized:
                return _local_record_to_user(record)
        return None

    from sqlalchemy import select

    with session_scope() as session:
        stmt = select(users_table).where(users_table.c.nickname == normalized)
        row = session.execute(stmt).mappings().first()
    if not row:
        return None

    return AuthUser(
        id=int(row["id"]),
        nickname=str(row["nickname"]),
        password_hash=str(row["password_hash"]),
        created_at=row["created_at"],
    )


def create_user(nickname: str, password: str) -> Optional[AuthUser]:
    normalized = _normalize_nickname(nickname)
    if not normalized or not password:
        return None
    if get_user_by_nickname(normalized):
        return None

    created_at = datetime.now(timezone.utc)
    # На некоторых системах (например, Python 3.8 + старый OpenSSL)
    # hashlib.scrypt недоступен. Явно используем совместимый алгоритм.
    password_hash = generate_password_hash(password, method="pbkdf2:sha256")

    if LOCAL_MODE:
        try:
            snapshot = _LOCAL_STORE.snapshot()
            users = list(snapshot.get("users", []))
            last_id = int(snapshot.get("last_id", 0)) + 1
            record = {
                "id": last_id,
                "nickname": normalized,
                "password_hash": password_hash,
                "created_at": created_at.isoformat(),
            }
            users.append(record)
            snapshot["users"] = users
            snapshot["last_id"] = last_id
            _LOCAL_STORE.persist(snapshot)
            return _local_record_to_user(record)
        except Exception:
            logger.exception("Failed to persist local user: %s", normalized)
            raise

    from sqlalchemy import insert
    from sqlalchemy.exc import IntegrityError

    try:
        with session_scope() as session:
            stmt = (
                insert(users_table)
                .values(
                    nickname=normalized,
                    password_hash=password_hash,
                    created_at=created_at,
                )
                .returning(
                    users_table.c.id,
                    users_table.c.nickname,
                    users_table.c.password_hash,
                    users_table.c.created_at,
                )
            )
            row = session.execute(stmt).mappings().one()
    except IntegrityError:
        return None

    return AuthUser(
        id=int(row["id"]),
        nickname=str(row["nickname"]),
        password_hash=str(row["password_hash"]),
        created_at=row["created_at"],
    )


def verify_user_credentials(nickname: str, password: str) -> Optional[AuthUser]:
    user = get_user_by_nickname(nickname)
    if not user:
        return None
    if not check_password_hash(user.password_hash, password):
        return None
    return user
