from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
import json
import logging
import secrets
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from uuid import uuid4

from config import CATEGORY_DEFINITIONS, LOCAL_PINS_PATH, is_local_mode, ttl_for
from database import (
    LocalPinStore,
    metadata,
    pins_table,
    session_scope,
    votes_table,
    friendships_table,
    users_table,
)


LOCAL_MODE = is_local_mode()
_LOCAL_STORE = LocalPinStore(LOCAL_PINS_PATH) if LOCAL_MODE else None
logger = logging.getLogger(__name__)


if not LOCAL_MODE and metadata is not None and friendships_table is not None and users_table is not None:
    from sqlalchemy.orm import declarative_base, relationship

    Base = declarative_base(metadata=metadata)


    class Friendship(Base):
        __table__ = friendships_table
        user = relationship(
            "User",
            foreign_keys=[friendships_table.c.user_id],
            back_populates="_friendships",
        )
        friend = relationship(
            "User",
            foreign_keys=[friendships_table.c.friend_id],
            viewonly=True,
        )


    class User(Base):
        __table__ = users_table
        _friendships = relationship(
            "Friendship",
            back_populates="user",
            lazy="joined",
        )
        friends = relationship(
            "User",
            secondary=friendships_table,
            primaryjoin=users_table.c.nickname == friendships_table.c.user_id,
            secondaryjoin=users_table.c.nickname == friendships_table.c.friend_id,
            viewonly=True,
            lazy="joined",
        )

else:
    Base = None  # type: ignore
    Friendship = None  # type: ignore
    User = None  # type: ignore


def _coerce_dt(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_metadata(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, str):
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def _normalize_votes(raw_votes: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_votes, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for entry in raw_votes:
        if not isinstance(entry, dict):
            continue
        vote_value = _coerce_vote_value(entry.get("vote_value"))
        if vote_value == 0:
            continue
        normalized.append(
            {
                "user_id": str(entry.get("user_id") or "").strip(),
                "vote_value": vote_value,
                "created_at": str(entry.get("created_at") or ""),
                "updated_at": str(entry.get("updated_at") or ""),
            }
        )
    return normalized


def _ensure_votes_container(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = dict(metadata or {})
    votes = payload.get("votes")
    if not isinstance(votes, list):
        payload["votes"] = []
    else:
        payload["votes"] = _normalize_votes(votes)
    return payload


def _ensure_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = _ensure_comments_container(metadata)
    payload = _ensure_votes_container(payload)
    return payload


def _coerce_vote_value(value: Any) -> int:
    try:
        vote = int(value)
    except (TypeError, ValueError):
        return 0
    return vote if vote in (-1, 1) else 0


def _make_comment_entry(user_id: str, text: str) -> Dict[str, str]:
    return {
        "id": uuid4().hex,
        "user_id": user_id,
        "text": text,
        "timestamp": _now_iso(),
    }


def _remove_comment_entry(
    metadata: Dict[str, Any], comment_id: str, user_id: str
) -> Tuple[str, Dict[str, Any]]:
    payload = _ensure_comments_container(metadata)
    comments = payload.get("comments", [])
    target_id = str(comment_id or "")
    for idx, entry in enumerate(list(comments)):
        if str(entry.get("id") or "") != target_id:
            continue
        if str(entry.get("user_id") or "") != str(user_id or ""):
            return "forbidden", payload
        del comments[idx]
        return "ok", payload
    return "not_found", payload


@dataclass
class Pin:
    id: int
    category: str
    category_slug: str
    subcategory_slug: str
    nickname: str
    description: str
    contact: Optional[str]
    lat: float
    lng: float
    created_at: datetime
    expires_at: Optional[datetime]
    rating: int
    metadata: Optional[Dict]
    shared_token: Optional[str]
    user_id: str

    @property
    def ttl_seconds(self) -> Optional[int]:
        if self.expires_at:
            delta = self.expires_at - datetime.now(timezone.utc)
            return max(int(delta.total_seconds()), 0)
        return None

    @property
    def color(self) -> str:
        for group in CATEGORY_DEFINITIONS:
            if group["slug"] == self.category_slug:
                return group["color"]
        return "#ffffff"

    def to_dict(self) -> Dict:
        payload = asdict(self)
        payload["created_at"] = self.created_at.isoformat()
        payload["expires_at"] = self.expires_at.isoformat() if self.expires_at else None
        payload["ttl_seconds"] = self.ttl_seconds
        payload["metadata"] = self.metadata or {}
        payload["category"] = self.category
        payload["user_id"] = self.user_id
        payload["rating"] = int(self.rating or 0)
        payload["comments"] = self.comments
        likes, dislikes = self.vote_counts
        payload["likes_count"] = likes
        payload["dislikes_count"] = dislikes
        return payload

    @property
    def comments(self) -> List[Dict[str, str]]:
        metadata = self.metadata or {}
        return _normalize_comments(metadata.get("comments"))

    @property
    def vote_entries(self) -> List[Dict[str, Any]]:
        metadata = self.metadata or {}
        return _ensure_votes_container(metadata).get("votes", [])

    @property
    def vote_counts(self) -> tuple[int, int]:
        return _count_vote_entries(self.vote_entries)


def _normalize_comments(raw_comments: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_comments, list):
        return []
    normalized: List[Dict[str, str]] = []
    for entry in raw_comments:
        if not isinstance(entry, dict):
            continue
        normalized.append(
            {
                "id": str(entry.get("id") or ""),
                "user_id": str(entry.get("user_id") or ""),
                "text": str(entry.get("text") or ""),
                "timestamp": str(entry.get("timestamp") or ""),
            }
        )
    return normalized


def _ensure_comments_container(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = dict(metadata or {})
    comments = payload.get("comments")
    if not isinstance(comments, list):
        payload["comments"] = []
    else:
        payload["comments"] = _normalize_comments(comments)
    return payload


def _normalize_votes(raw_votes: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_votes, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for entry in raw_votes:
        if not isinstance(entry, dict):
            continue
        vote_value = entry.get("vote_value")
        try:
            vote_value = int(vote_value)
        except (TypeError, ValueError):
            vote_value = 0
        if vote_value not in (-1, 1):
            continue
        normalized.append(
            {
                "user_id": str(entry.get("user_id") or "").strip(),
                "vote_value": vote_value,
                "created_at": str(entry.get("created_at") or ""),
                "updated_at": str(entry.get("updated_at") or ""),
            }
        )
    return normalized


def _ensure_votes_container(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = dict(metadata or {})
    votes = payload.get("votes")
    if not isinstance(votes, list):
        payload["votes"] = []
    else:
        payload["votes"] = _normalize_votes(votes)
    return payload


def _ensure_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    payload = _ensure_comments_container(metadata)
    payload = _ensure_votes_container(payload)
    return payload


def add_comment(pin_id: int, user_id: str, text: str) -> Optional[List[Dict[str, str]]]:
    """Append a comment to a pin and return updated comments list."""
    cleaned_text = (text or "").strip()
    if not cleaned_text:
        raise ValueError("Text must be provided")

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        target_idx = None
        now = datetime.now(timezone.utc)
        for idx, record in enumerate(pins):
            if int(record.get("id", 0)) != pin_id:
                continue
            if not _pin_is_active(record, now):
                return None
            target_idx = idx
            break
        if target_idx is None:
            return None
        record = dict(pins[target_idx])
        payload = _ensure_comments_container(record.get("metadata") or {})
        entry = _make_comment_entry(user_id, cleaned_text)
        payload["comments"].append(entry)
        record["metadata"] = payload
        pins[target_idx] = _serialize_local_record(record)
        snapshot["pins"] = pins
        _LOCAL_STORE.persist(snapshot)
        return _normalize_comments(payload["comments"])

    from sqlalchemy import select, update

    with session_scope() as session:
        stmt = select(pins_table.c.metadata, pins_table.c.expires_at).where(pins_table.c.id == pin_id)
        row = session.execute(stmt).mappings().first()
        if not row:
            return None
        expires_at = _coerce_dt(row.get("expires_at"))
        if expires_at and expires_at <= datetime.now(timezone.utc):
            return None
        payload = _ensure_comments_container(_parse_metadata(row.get("metadata")))
        entry = _make_comment_entry(user_id, cleaned_text)
        payload["comments"].append(entry)
        update_stmt = (
            update(pins_table)
            .where(pins_table.c.id == pin_id)
            .values(metadata=json.dumps(payload))
        )
        session.execute(update_stmt)
    return _normalize_comments(payload["comments"])


def delete_comment(
    pin_id: int, user_id: str, comment_id: str
) -> Tuple[str, Optional[List[Dict[str, str]]]]:
    """Delete comment if author matches. Returns (status, updated_comments/None)."""

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        target_idx = None
        now = datetime.now(timezone.utc)
        for idx, record in enumerate(pins):
            if int(record.get("id", 0)) != pin_id:
                continue
            if not _pin_is_active(record, now):
                return ("pin_not_found", None)
            target_idx = idx
            break
        if target_idx is None:
            return ("pin_not_found", None)
        record = dict(pins[target_idx])
        payload = _ensure_comments_container(record.get("metadata") or {})
        status, updated_payload = _remove_comment_entry(payload, comment_id, user_id)
        if status != "ok":
            return (status, None)
        record["metadata"] = updated_payload
        pins[target_idx] = _serialize_local_record(record)
        snapshot["pins"] = pins
        _LOCAL_STORE.persist(snapshot)
        return ("ok", _normalize_comments(updated_payload.get("comments", [])))

    from sqlalchemy import select, update

    with session_scope() as session:
        stmt = select(pins_table.c.metadata, pins_table.c.expires_at).where(pins_table.c.id == pin_id)
        row = session.execute(stmt).mappings().first()
        if not row:
            return ("pin_not_found", None)
        expires_at = _coerce_dt(row.get("expires_at"))
        if expires_at and expires_at <= datetime.now(timezone.utc):
            return ("pin_not_found", None)
        payload = _ensure_comments_container(_parse_metadata(row.get("metadata")))
        status, updated_payload = _remove_comment_entry(payload, comment_id, user_id)
        if status != "ok":
            return (status, None)
        update_stmt = (
            update(pins_table)
            .where(pins_table.c.id == pin_id)
            .values(metadata=json.dumps(updated_payload))
        )
        session.execute(update_stmt)
    return ("ok", _normalize_comments(updated_payload.get("comments", [])))
def _mapping_to_pin(row: Mapping[str, Any]) -> Pin:
    raw_metadata = row.get("metadata")
    metadata_payload = _parse_metadata(raw_metadata)

    created_at = _coerce_dt(row.get("created_at")) or datetime.now(timezone.utc)

    return Pin(
        id=int(row.get("id", 0)),
        category=str(row.get("category") or ""),
        category_slug=str(row.get("category_slug") or ""),
        subcategory_slug=str(row.get("subcategory_slug") or ""),
        nickname=str(row.get("nickname") or ""),
        description=str(row.get("description") or ""),
        contact=row.get("contact"),
        lat=float(row.get("lat", 0.0)),
        lng=float(row.get("lng", 0.0)),
        created_at=created_at,
        expires_at=_coerce_dt(row.get("expires_at")),
        rating=int(row.get("rating", 0)),
        metadata=_ensure_metadata(metadata_payload),
        shared_token=row.get("shared_token"),
        user_id=str(row.get("user_id") or ""),
    )


def _pin_is_active(record: Mapping[str, Any], now: datetime) -> bool:
    expires_at = _coerce_dt(record.get("expires_at"))
    return expires_at is None or expires_at > now


def _serialize_local_record(record: Dict[str, Any]) -> Dict[str, Any]:
    payload = dict(record)
    created_at = payload.get("created_at")
    expires_at = payload.get("expires_at")
    payload["metadata"] = _ensure_metadata(payload.get("metadata") or {})
    if isinstance(created_at, datetime):
        payload["created_at"] = created_at.isoformat()
    if isinstance(expires_at, datetime):
        payload["expires_at"] = expires_at.isoformat()
    return payload


def _count_vote_entries(entries: Sequence[Mapping[str, Any]]) -> tuple[int, int]:
    likes = 0
    dislikes = 0
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        vote_value = entry.get("vote_value")
        try:
            vote_value = int(vote_value)
        except (TypeError, ValueError):
            continue
        if vote_value == 1:
            likes += 1
        elif vote_value == -1:
            dislikes += 1
    return likes, dislikes


def vote_counts_for_pin(
    pin_id: int,
    metadata: Optional[Dict[str, Any]] = None,
    *,
    session: object | None = None,
) -> tuple[int, int]:
    if LOCAL_MODE:
        data = metadata or {}
        votes = _ensure_votes_container(data).get("votes", [])
        return _count_vote_entries(votes)

    from sqlalchemy import func, select

    def _load_counts(active_session: object) -> tuple[int, int]:
        likes_stmt = (
            select(func.count())
            .where(votes_table.c.pin_id == pin_id, votes_table.c.vote_value == 1)
        )
        dislikes_stmt = (
            select(func.count())
            .where(votes_table.c.pin_id == pin_id, votes_table.c.vote_value == -1)
        )
        likes = active_session.execute(likes_stmt).scalar_one_or_none() or 0
        dislikes = active_session.execute(dislikes_stmt).scalar_one_or_none() or 0
        return int(likes), int(dislikes)

    if session is None:
        with session_scope() as scoped_session:
            return _load_counts(scoped_session)
    return _load_counts(session)


def create_pin(
    category: str,
    category_slug: str,
    subcategory_slug: str,
    nickname: str,
    description: str,
    lat: float,
    lng: float,
    contact: Optional[str],
    user_id: str,
    metadata: Optional[Dict] = None,
) -> Pin:
    ttl = ttl_for(subcategory_slug)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=ttl) if ttl else None
    token = secrets.token_urlsafe(12)
    payload = _ensure_metadata(metadata)

    print(f"create_pin: {category=} {category_slug=} {subcategory_slug=} {nickname=} {lat=} {lng=}")

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        last_id = int(snapshot.get("last_id", 0)) + 1

        record = {
            "id": last_id,
            "category": category,
            "category_slug": category_slug,
            "subcategory_slug": subcategory_slug,
            "nickname": nickname,
            "description": description,
            "contact": contact,
            "lat": lat,
            "lng": lng,
            "created_at": now,
            "expires_at": expires_at,
            "rating": 0,
            "metadata": payload,
            "shared_token": token,
            "user_id": user_id,
        }

        pins.append(_serialize_local_record(record))
        snapshot["pins"] = pins
        snapshot["last_id"] = last_id
        _LOCAL_STORE.persist(snapshot)
        return _mapping_to_pin(record)

    from sqlalchemy import insert

    with session_scope() as session:
        stmt = (
            insert(pins_table)
            .values(
                category=category,
                category_slug=category_slug,
                subcategory_slug=subcategory_slug,
                nickname=nickname,
                description=description,
                contact=contact,
                lat=lat,
                lng=lng,
                created_at=now,
                expires_at=expires_at,
                metadata=json.dumps(payload),
                shared_token=token,
                user_id=user_id,
            )
            .returning(pins_table.c.id)
        )
        rowid = session.execute(stmt).scalar_one()

    return get_pin_by_id(rowid)


def get_pin_by_id(pin_id: int) -> Optional[Pin]:
    now_iso = datetime.now(timezone.utc)

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        for record in snapshot.get("pins", []):
            if int(record.get("id", 0)) == pin_id and _pin_is_active(record, now_iso):
                return _mapping_to_pin(record)
        return None

    from sqlalchemy import select

    with session_scope() as session:
        stmt = select(pins_table).where(
            pins_table.c.id == pin_id,
            (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
        )
        row = session.execute(stmt).mappings().first()
        if not row:
            return None
    return _mapping_to_pin(row)


def active_pins(
    allowed_subcategories: Optional[List[str]] = None,
    rating_threshold: int = -999,
) -> List[Pin]:
    now_iso = datetime.now(timezone.utc)

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        filtered: List[Pin] = []
        for record in snapshot.get("pins", []):
            if not _pin_is_active(record, now_iso):
                continue
            if int(record.get("rating", 0)) < rating_threshold:
                continue
            if allowed_subcategories and record.get("subcategory_slug") not in allowed_subcategories:
                continue
            filtered.append(_mapping_to_pin(record))
        return filtered

    from sqlalchemy import select

    stmt = select(pins_table).where(
        (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
        pins_table.c.rating >= rating_threshold,
    )
    if allowed_subcategories:
        stmt = stmt.where(pins_table.c.subcategory_slug.in_(allowed_subcategories))
    with session_scope() as session:
        rows = session.execute(stmt).mappings().all()
    return [_mapping_to_pin(row) for row in rows]


def count_active_pins_for_user(user_id: str) -> int:
    if not user_id:
        return 0
    now_iso = datetime.now(timezone.utc)

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        count = 0
        for record in snapshot.get("pins", []):
            if str(record.get("user_id") or "") != user_id:
                continue
            if _pin_is_active(record, now_iso):
                count += 1
        return count

    from sqlalchemy import func, select

    with session_scope() as session:
        stmt = select(func.count()).select_from(pins_table).where(
            pins_table.c.user_id == user_id,
            (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
        )
        result = session.execute(stmt).scalar()
    return result or 0


def get_pin_owner(pin_id: int) -> Optional[str]:
    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        for record in snapshot.get("pins", []):
            if int(record.get("id", 0)) == pin_id:
                return str(record.get("user_id") or "")
        return None

    from sqlalchemy import select

    with session_scope() as session:
        stmt = select(pins_table.c.user_id).where(pins_table.c.id == pin_id)
        row = session.execute(stmt).scalar_one_or_none()
    return row


def get_user_rating_total(user_id: str) -> int:
    if not user_id:
        return 0
    now_iso = datetime.now(timezone.utc)

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        total = 0
        for record in snapshot.get("pins", []):
            if str(record.get("user_id") or "") != user_id:
                continue
            if not _pin_is_active(record, now_iso):
                continue
            total += int(record.get("rating", 0))
        return total

    from sqlalchemy import func, select

    with session_scope() as session:
        stmt = (
            select(func.coalesce(func.sum(pins_table.c.rating), 0))
            .where(
                pins_table.c.user_id == user_id,
                (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
            )
        )
        result = session.execute(stmt).scalar()
    return int(result or 0)


def adjust_rating(pin_id: int, delta: int = 1) -> Optional[int]:
    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        for idx, record in enumerate(pins):
            if int(record.get("id", 0)) != pin_id:
                continue
            current = int(record.get("rating", 0))
            record["rating"] = current + delta
            pins[idx] = record
            snapshot["pins"] = pins
            _LOCAL_STORE.persist(snapshot)
            return int(record["rating"])
        return None

    from sqlalchemy import update

    with session_scope() as session:
        stmt = (
            update(pins_table)
            .where(pins_table.c.id == pin_id)
            .values(rating=pins_table.c.rating + delta)
            .returning(pins_table.c.rating)
        )
        result = session.execute(stmt).scalar_one_or_none()
    return result


def record_vote(pin_id: int, user_id: str, vote_value: int) -> Optional[dict]:
    vote_value = _coerce_vote_value(vote_value)
    now = datetime.now(timezone.utc)

    if not user_id:
        raise ValueError("Нужен идентификатор пользователя для голосования.")

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        for idx, record in enumerate(pins):
            if int(record.get("id", 0)) != pin_id:
                continue
            if not _pin_is_active(record, now):
                return None
            metadata = _ensure_votes_container(record.get("metadata") or {})
            votes = metadata["votes"]
            existing = next((entry for entry in votes if entry.get("user_id") == user_id), None)
            previous_value = int(existing.get("vote_value", 0)) if existing else 0
            delta = 0
            if vote_value == 0:
                if existing:
                    delta = -previous_value
                    votes.remove(existing)
                else:
                    delta = 0
            else:
                if existing:
                    if previous_value == vote_value:
                        delta = 0
                    else:
                        delta = vote_value - previous_value
                        existing["vote_value"] = vote_value
                        existing["updated_at"] = now.isoformat()
                else:
                    delta = vote_value
                    votes.append(
                        {
                            "user_id": user_id,
                            "vote_value": vote_value,
                            "created_at": now.isoformat(),
                            "updated_at": now.isoformat(),
                        }
                    )
            record["metadata"] = metadata
            record["rating"] = int(record.get("rating", 0)) + delta
            snapshot["pins"][idx] = _serialize_local_record(record)  # type: ignore[index]
            snapshot["pins"] = snapshot["pins"]
            _LOCAL_STORE.persist(snapshot)
            pin_owner = str(record.get("user_id") or "")
            profile_rating = get_user_rating_total(pin_owner)
            likes_count, dislikes_count = vote_counts_for_pin(pin_id, metadata, session=None)
            logger.debug(
                "record_vote (local): pin=%s user=%s prev=%s new=%s delta=%s profile_rating=%s",
                pin_id,
                user_id,
                previous_value,
                vote_value,
                delta,
                profile_rating,
            )
            return {
                "pin_rating": int(record.get("rating", 0)),
                "vote_value": vote_value,
                "profile_rating": profile_rating,
                "pin_owner": pin_owner,
                "likes_count": likes_count,
                "dislikes_count": dislikes_count,
            }
        return None

    from sqlalchemy import delete, insert, select, update

    with session_scope() as session:
        stmt = select(pins_table.c.rating, pins_table.c.user_id, pins_table.c.expires_at).where(pins_table.c.id == pin_id)
        pin_row = session.execute(stmt).mappings().first()
        if not pin_row:
            return None
        expires_at = _coerce_dt(pin_row.get("expires_at"))
        if expires_at and expires_at <= now:
            return None
        owner = str(pin_row.get("user_id") or "")

        vote_stmt = (
            select(votes_table.c.id, votes_table.c.vote_value)
            .where(votes_table.c.pin_id == pin_id, votes_table.c.user_id == user_id)
            .limit(1)
        )
        vote_row = session.execute(vote_stmt).mappings().first()
        previous_value = int(vote_row.get("vote_value", 0)) if vote_row else 0
        delta = 0
        if vote_value == 0:
            if vote_row:
                delete_stmt = delete(votes_table).where(votes_table.c.pin_id == pin_id, votes_table.c.user_id == user_id)
                session.execute(delete_stmt)
                delta = -previous_value
        else:
            if vote_row:
                if previous_value != vote_value:
                    update_stmt = (
                        update(votes_table)
                        .where(votes_table.c.id == vote_row.get("id"))
                        .values(vote_value=vote_value, updated_at=now)
                    )
                    session.execute(update_stmt)
                    delta = vote_value - previous_value
            else:
                insert_stmt = insert(votes_table).values(
                    pin_id=pin_id,
                    user_id=user_id,
                    vote_value=vote_value,
                    created_at=now,
                    updated_at=now,
                )
                session.execute(insert_stmt)
                delta = vote_value
        pin_update_delta = delta
        if pin_update_delta:
            update_pin = (
                update(pins_table)
                .where(pins_table.c.id == pin_id)
                .values(rating=pins_table.c.rating + pin_update_delta)
            )
            session.execute(update_pin)
            session.commit()

        rating_stmt = select(pins_table.c.rating).where(pins_table.c.id == pin_id)
        updated_rating = session.execute(rating_stmt).scalar_one_or_none()
        profile_rating = get_user_rating_total(owner)
        likes_count, dislikes_count = vote_counts_for_pin(pin_id, session=session)
        logger.debug(
            "record_vote: pin=%s user=%s prev=%s new=%s delta=%s profile_rating=%s",
            pin_id,
            user_id,
            previous_value,
            vote_value,
            delta,
            profile_rating,
        )
        return {
            "pin_rating": int(updated_rating or 0),
            "vote_value": vote_value,
            "profile_rating": profile_rating,
            "pin_owner": owner,
            "likes_count": int(likes_count),
            "dislikes_count": int(dislikes_count),
        }


def user_votes_for_pins(user_id: str, pin_ids: Sequence[int]) -> Dict[int, int]:
    if not user_id or not pin_ids:
        return {}
    target_ids = {int(pid) for pid in pin_ids if isinstance(pid, int) and pid > 0}
    if not target_ids:
        return {}

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        votes: Dict[int, int] = {}
        for record in snapshot.get("pins", []):
            try:
                pin_id_value = int(record.get("id", 0))
            except (TypeError, ValueError):
                continue
            if pin_id_value not in target_ids:
                continue
            metadata = _ensure_votes_container(record.get("metadata") or {})
            for entry in metadata.get("votes", []):
                if entry.get("user_id") == user_id:
                    votes[pin_id_value] = int(entry.get("vote_value", 0))
                    break
        return votes

    from sqlalchemy import select

    with session_scope() as session:
        stmt = (
            select(votes_table.c.pin_id, votes_table.c.vote_value)
            .where(
                votes_table.c.user_id == user_id,
                votes_table.c.pin_id.in_(tuple(target_ids)),
            )
        )
        rows = session.execute(stmt).mappings().all()
    return {int(row["pin_id"]): int(row["vote_value"]) for row in rows}

def cleanup_expired() -> int:
    now_iso = datetime.now(timezone.utc)

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        retained = []
        deleted = 0
        for record in pins:
            expires_at = _coerce_dt(record.get("expires_at"))
            if expires_at is not None and expires_at <= now_iso:
                deleted += 1
                continue
            retained.append(record)
        if deleted:
            snapshot["pins"] = retained
            _LOCAL_STORE.persist(snapshot)
        return deleted

    from sqlalchemy import delete

    with session_scope() as session:
        stmt = delete(pins_table).where(
            pins_table.c.expires_at.is_not(None),
            pins_table.c.expires_at <= now_iso,
        )
        result = session.execute(stmt)
        deleted = result.rowcount or 0
    return deleted


def delete_pin(pin_id: int, user_id: str) -> bool:
    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        retained = []
        deleted = 0
        for record in pins:
            if int(record.get("id", 0)) == pin_id and str(record.get("user_id") or "") == user_id:
                deleted += 1
                continue
            retained.append(record)
        if deleted:
            snapshot["pins"] = retained
            _LOCAL_STORE.persist(snapshot)
        return deleted > 0

    from sqlalchemy import delete

    with session_scope() as session:
        stmt = delete(pins_table).where(
            pins_table.c.id == pin_id,
            pins_table.c.user_id == user_id,
        )
        result = session.execute(stmt)
        deleted = result.rowcount or 0
    return deleted > 0


def reassign_user_id(old_user_id: str, new_user_id: str) -> int:
    """Переназначает владельца во всех активных пинах."""
    old_user_id = (old_user_id or "").strip()
    new_user_id = (new_user_id or "").strip()
    if not old_user_id or not new_user_id:
        raise ValueError("Некорректные имена пользователей для обновления user_id.")
    if old_user_id == new_user_id:
        return 0

    if LOCAL_MODE:
        snapshot = _LOCAL_STORE.snapshot()
        pins = list(snapshot.get("pins", []))
        updated = 0
        for idx, record in enumerate(pins):
            if str(record.get("user_id") or "") != old_user_id:
                continue
            record = dict(record)
            record["user_id"] = new_user_id
            pins[idx] = record
            updated += 1
        if updated:
            snapshot["pins"] = pins
            _LOCAL_STORE.persist(snapshot)
        return updated

    from sqlalchemy import update

    with session_scope() as session:
        stmt = (
            update(pins_table)
            .where(pins_table.c.user_id == old_user_id)
            .values(user_id=new_user_id)
        )
        result = session.execute(stmt)
        return result.rowcount or 0
