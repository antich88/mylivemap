from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from werkzeug.security import check_password_hash, generate_password_hash

from config import LOCAL_PROFILES_PATH, LOCAL_USERS_PATH, is_local_mode
from database import profiles_table, session_scope, users_table


LOCAL_MODE = is_local_mode()
logger = logging.getLogger(__name__)


@dataclass
class AuthUser:
    id: int
    nickname: str
    password_hash: str
    created_at: datetime


class NicknameAlreadyExistsError(RuntimeError):
    """Выбрасывается при попытке использовать занятое имя пользователя."""


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


class LocalProfileStore:
    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self.ensure_storage()

    def ensure_storage(self) -> None:
        if not self.storage_path.exists():
            self.storage_path.write_text(
                json.dumps({"profiles": []}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def snapshot(self) -> Dict[str, Any]:
        self.ensure_storage()
        try:
            return json.loads(self.storage_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"profiles": []}

    def persist(self, payload: Dict[str, Any]) -> None:
        tmp_path = self.storage_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(self.storage_path)


_LOCAL_STORE = LocalUserStore(LOCAL_USERS_PATH) if LOCAL_MODE else None
_LOCAL_PROFILES_STORE = LocalProfileStore(LOCAL_PROFILES_PATH) if LOCAL_MODE else None

_PROFILE_UNSET = object()


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _default_profile_payload(nickname: str) -> Dict[str, Any]:
    timestamp = _now_utc().isoformat()
    return {
        "nickname": nickname,
        "age": None,
        "gender": None,
        "avatar_path": None,
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def _persist_local_profile(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not _LOCAL_PROFILES_STORE:
        return payload
    snapshot = _LOCAL_PROFILES_STORE.snapshot()
    profiles = list(snapshot.get("profiles", []))
    for idx, entry in enumerate(profiles):
        if str(entry.get("nickname") or "") == payload["nickname"]:
            profiles[idx] = payload
            break
    else:
        profiles.append(payload)
    snapshot["profiles"] = profiles
    _LOCAL_PROFILES_STORE.persist(snapshot)
    return payload


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


def _local_profile_record(nickname: str) -> Optional[Dict[str, Any]]:
    if not _LOCAL_PROFILES_STORE:
        return None
    snapshot = _LOCAL_PROFILES_STORE.snapshot()
    for entry in snapshot.get("profiles", []):
        if str(entry.get("nickname") or "") == nickname:
            return entry
    return None


def get_or_create_user_profile(nickname: str) -> Dict[str, Any]:
    normalized = _normalize_nickname(nickname)
    if not normalized:
        raise ValueError("Некорректное имя пользователя.")
    if LOCAL_MODE:
        existing = _local_profile_record(normalized)
        if existing:
            return existing
        payload = _default_profile_payload(normalized)
        return _persist_local_profile(payload)

    from sqlalchemy import insert, select

    with session_scope() as session:
        stmt = select(profiles_table).where(profiles_table.c.nickname == normalized)
        row = session.execute(stmt).mappings().first()
        if row:
            return dict(row)
        now = datetime.now(timezone.utc)
        payload = {
            "nickname": normalized,
            "age": None,
            "gender": None,
            "avatar_path": None,
            "created_at": now,
            "updated_at": now,
        }
        insert_stmt = (
            insert(profiles_table)
            .values(**payload)
            .returning(
                profiles_table.c.nickname,
                profiles_table.c.age,
                profiles_table.c.gender,
                profiles_table.c.avatar_path,
                profiles_table.c.created_at,
                profiles_table.c.updated_at,
            )
        )
        row = session.execute(insert_stmt).mappings().one()
    return dict(row)


def update_user_profile_fields(
    nickname: str,
    *,
    age: object = _PROFILE_UNSET,
    gender: object = _PROFILE_UNSET,
) -> Dict[str, Any]:
    normalized = _normalize_nickname(nickname)
    if not normalized:
        raise ValueError("Некорректное имя пользователя.")
    profile = get_or_create_user_profile(normalized)
    updates: Dict[str, Any] = {}
    if age is not _PROFILE_UNSET:
        updates["age"] = age
    if gender is not _PROFILE_UNSET:
        updates["gender"] = gender
    if not updates:
        return profile
    if LOCAL_MODE:
        profile = dict(profile)
        profile.update(updates)
        profile["updated_at"] = _now_utc().isoformat()
        return _persist_local_profile(profile)

    from sqlalchemy import select, update

    now = datetime.now(timezone.utc)
    updates_sql = dict(updates)
    updates_sql["updated_at"] = now
    with session_scope() as session:
        update_stmt = (
            update(profiles_table)
            .where(profiles_table.c.nickname == normalized)
            .values(**updates_sql)
        )
        session.execute(update_stmt)
        stmt = select(profiles_table).where(profiles_table.c.nickname == normalized)
        row = session.execute(stmt).mappings().first()
        if not row:
            raise ValueError("Профиль не найден.")
    return dict(row)


def update_user_avatar_path(nickname: str, avatar_path: Optional[str]) -> Dict[str, Any]:
    normalized = _normalize_nickname(nickname)
    if not normalized:
        raise ValueError("Некорректное имя пользователя.")
    profile = get_or_create_user_profile(normalized)
    if LOCAL_MODE:
        profile = dict(profile)
        profile["avatar_path"] = avatar_path
        profile["updated_at"] = _now_utc().isoformat()
        return _persist_local_profile(profile)

    from sqlalchemy import update

    now = datetime.now(timezone.utc)
    with session_scope() as session:
        stmt = (
            update(profiles_table)
            .where(profiles_table.c.nickname == normalized)
            .values(avatar_path=avatar_path, updated_at=now)
            .returning(
                profiles_table.c.nickname,
                profiles_table.c.age,
                profiles_table.c.gender,
                profiles_table.c.avatar_path,
                profiles_table.c.created_at,
                profiles_table.c.updated_at,
            )
        )
        row = session.execute(stmt).mappings().one_or_none()
        if row:
            return dict(row)
    return get_or_create_user_profile(normalized)


def rename_user_profile(old_nickname: str, new_nickname: str) -> None:
    old_normalized = _normalize_nickname(old_nickname)
    new_normalized = _normalize_nickname(new_nickname)
    if not old_normalized or not new_normalized:
        raise ValueError("Некорректные имена пользователей.")
    if old_normalized == new_normalized:
        return
    if LOCAL_MODE:
        snapshot = _LOCAL_PROFILES_STORE.snapshot()
        profiles = list(snapshot.get("profiles", []))
        for entry in profiles:
            if str(entry.get("nickname") or "") != old_normalized:
                continue
            entry["nickname"] = new_normalized
            entry["updated_at"] = _now_utc().isoformat()
            snapshot["profiles"] = profiles
            _LOCAL_PROFILES_STORE.persist(snapshot)
            return
        return

    from sqlalchemy import update

    now = datetime.now(timezone.utc)
    with session_scope() as session:
        stmt = (
            update(profiles_table)
            .where(profiles_table.c.nickname == old_normalized)
            .values(nickname=new_normalized, updated_at=now)
        )
        session.execute(stmt)


def update_user_password(nickname: str, current_password: str, new_password: str) -> None:
    normalized = _normalize_nickname(nickname)
    if not normalized:
        raise ValueError("Некорректное имя пользователя.")
    if len(new_password or "") < 6:
        raise ValueError("Новый пароль должен быть не короче 6 символов.")
    user = verify_user_credentials(normalized, current_password)
    if not user:
        raise ValueError("Текущий пароль неверен.")
    new_hash = generate_password_hash(new_password, method="pbkdf2:sha256")
    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        users = list(snapshot.get("users", []))
        for record in users:
            if str(record.get("nickname") or "") != normalized:
                continue
            record["password_hash"] = new_hash
            snapshot["users"] = users
            _LOCAL_STORE.persist(snapshot)
            return
        raise ValueError("Пользователь не найден.")

    from sqlalchemy import update

    with session_scope() as session:
        stmt = (
            update(users_table)
            .where(users_table.c.id == user.id)
            .values(password_hash=new_hash)
        )
        session.execute(stmt)


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


def update_user_nickname(current_nickname: str, next_nickname: str) -> AuthUser:
    current = _normalize_nickname(current_nickname)
    updated = _normalize_nickname(next_nickname)

    if not current or not updated:
        raise ValueError("Некорректное имя пользователя.")
    if len(updated) < 3:
        raise ValueError("Имя должно быть не короче 3 символов.")
    if len(updated) > 16:
        raise ValueError("Имя должно быть не длиннее 16 символов.")

    if current == updated:
        user = get_user_by_nickname(current)
        if not user:
            raise ValueError("Пользователь не найден.")
        return user

    if get_user_by_nickname(updated):
        raise NicknameAlreadyExistsError(updated)

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        users = list(snapshot.get("users", []))
        for record in users:
            if str(record.get("nickname") or "") != current:
                continue
            record["nickname"] = updated
            snapshot["users"] = users
            _LOCAL_STORE.persist(snapshot)
            rename_user_profile(current, updated)
            return _local_record_to_user(record)
        raise ValueError("Пользователь не найден.")

    from sqlalchemy import update
    from sqlalchemy.exc import IntegrityError

    with session_scope() as session:
        stmt = (
            update(users_table)
            .where(users_table.c.nickname == current)
            .values(nickname=updated)
            .returning(
                users_table.c.id,
                users_table.c.nickname,
                users_table.c.password_hash,
                users_table.c.created_at,
            )
        )
        try:
            row = session.execute(stmt).mappings().one_or_none()
            if row:
                rename_user_profile(current, updated)
        except IntegrityError:
            raise NicknameAlreadyExistsError(updated) from None
    if not row:
        raise ValueError("Пользователь не найден.")

    return AuthUser(
        id=int(row["id"]),
        nickname=str(row["nickname"]),
        password_hash=str(row["password_hash"]),
        created_at=row["created_at"],
    )
