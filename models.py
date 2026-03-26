from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone, timedelta
import json
import secrets
from typing import Dict, List, Optional

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.engine import RowMapping

from config import CATEGORY_DEFINITIONS, ttl_for
from database import pins_table, session_scope


def _coerce_dt(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


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
        return payload
def _mapping_to_pin(row: RowMapping) -> Pin:
    metadata_payload = json.loads(row["metadata"]) if row["metadata"] else None
    return Pin(
        id=row["id"],
        category=row["category"],
        category_slug=row["category_slug"],
        subcategory_slug=row["subcategory_slug"],
        nickname=row["nickname"],
        description=row["description"],
        contact=row["contact"],
        lat=row["lat"],
        lng=row["lng"],
        created_at=_coerce_dt(row["created_at"]),
        expires_at=_coerce_dt(row["expires_at"]),
        rating=row["rating"],
        metadata=metadata_payload,
        shared_token=row["shared_token"],
        user_id=row["user_id"] or "",
    )


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
    payload = metadata or {}

    print(f"create_pin: {category=} {category_slug=} {subcategory_slug=} {nickname=} {lat=} {lng=}" )
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
    with session_scope() as session:
        stmt = select(func.count()).select_from(pins_table).where(
            pins_table.c.user_id == user_id,
            (pins_table.c.expires_at.is_(None) | (pins_table.c.expires_at > now_iso)),
        )
        result = session.execute(stmt).scalar()
    return result or 0


def get_pin_owner(pin_id: int) -> Optional[str]:
    with session_scope() as session:
        stmt = select(pins_table.c.user_id).where(pins_table.c.id == pin_id)
        row = session.execute(stmt).scalar_one_or_none()
    return row


def adjust_rating(pin_id: int, delta: int = 1) -> Optional[int]:
    with session_scope() as session:
        stmt = (
            update(pins_table)
            .where(pins_table.c.id == pin_id)
            .values(rating=pins_table.c.rating + delta)
            .returning(pins_table.c.rating)
        )
        result = session.execute(stmt).scalar_one_or_none()
    return result


def cleanup_expired() -> int:
    now_iso = datetime.now(timezone.utc)
    with session_scope() as session:
        stmt = delete(pins_table).where(
            pins_table.c.expires_at.is_not(None),
            pins_table.c.expires_at <= now_iso,
        )
        result = session.execute(stmt)
        deleted = result.rowcount or 0
    return deleted


def delete_pin(pin_id: int, user_id: str) -> bool:
    with session_scope() as session:
        stmt = delete(pins_table).where(
            pins_table.c.id == pin_id,
            pins_table.c.user_id == user_id,
        )
        result = session.execute(stmt)
        deleted = result.rowcount or 0
    return deleted > 0
