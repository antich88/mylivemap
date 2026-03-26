from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import (
    Column,
    DateTime,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    create_engine,
    text,
)
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from config import DATABASE_URL


def _sqlite_kwargs(url: str) -> dict:
    if url.startswith("sqlite"):
        return {"connect_args": {"check_same_thread": False}}
    return {}


ENGINE = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    future=True,
    **_sqlite_kwargs(DATABASE_URL),
)

SessionLocal = sessionmaker(bind=ENGINE, autoflush=False, autocommit=False, expire_on_commit=False, future=True)

metadata = MetaData()

pins_table = Table(
    "pins",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("category", String(255)),
    Column("category_slug", String(255), nullable=False),
    Column("subcategory_slug", String(255), nullable=False),
    Column("nickname", String(255), nullable=False),
    Column("description", Text, nullable=False),
    Column("contact", String(255)),
    Column("lat", Float, nullable=False),
    Column("lng", Float, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("expires_at", DateTime(timezone=True)),
    Column("rating", Integer, nullable=False, server_default=text("0")),
    Column("metadata", Text),
    Column("shared_token", String(255), unique=True),
    Column("user_id", String(255), nullable=False, default=""),
    UniqueConstraint("shared_token", name="uq_pins_shared_token"),
)


def init_schema() -> None:
    metadata.create_all(ENGINE)


def ensure_connection() -> None:
    try:
        with ENGINE.connect() as conn:
            conn.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# Initialize schema eagerly for SQLite/local dev; Render Postgres performs same call on boot
if DATABASE_URL.startswith("sqlite"):
    init_schema()
