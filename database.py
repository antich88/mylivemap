from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Iterator

from config import DATABASE_URL, LOCAL_PINS_PATH, is_local_mode

LOCAL_MODE = is_local_mode()


class LocalPinStore:
    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        self.ensure_storage()

    def ensure_storage(self) -> None:
        if not self.storage_path.exists():
            self.storage_path.write_text(
                json.dumps({"pins": [], "last_id": 0}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    def snapshot(self) -> Dict[str, object]:
        self.ensure_storage()
        try:
            return json.loads(self.storage_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"pins": [], "last_id": 0}

    def persist(self, payload: Dict[str, object]) -> None:
        tmp_path = self.storage_path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(self.storage_path)


if LOCAL_MODE:
    _LOCAL_STORE = LocalPinStore(LOCAL_PINS_PATH)


    def init_schema() -> None:
        _LOCAL_STORE.ensure_storage()


    def ensure_connection() -> None:
        _LOCAL_STORE.ensure_storage()


    @contextmanager
    def session_scope() -> Iterator[object]:
        raise RuntimeError("SQLAlchemy session недоступен в локальном режиме")


    metadata = None  # type: ignore
    pins_table = None  # type: ignore

else:
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

    def _sqlite_kwargs(url: str) -> dict:
        if url.startswith("sqlite"):
            return {"connect_args": {"check_same_thread": False}}
        return {}

    engine_kwargs = {
        "pool_pre_ping": True,
        "future": True,
        **_sqlite_kwargs(DATABASE_URL),
    }

    if DATABASE_URL.startswith("postgres"):
        try:  # pragma: no cover
            import psycopg2  # type: ignore  # noqa: F401
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "psycopg2-binary должен быть установлен для подключения к Postgres"
            ) from exc

    ENGINE = create_engine(DATABASE_URL, **engine_kwargs)

    SessionLocal = sessionmaker(
        bind=ENGINE,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )

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
        except SQLAlchemyError:  # pragma: no cover
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


    if DATABASE_URL.startswith("sqlite"):
        init_schema()
