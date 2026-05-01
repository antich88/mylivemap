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
    users_table = None  # type: ignore
    profiles_table = None  # type: ignore
    votes_table = None  # type: ignore
    friendships_table = None  # type: ignore
    user_subscriptions_table = None  # type: ignore

else:
    from sqlalchemy import (
        Column,
        DateTime,
        Float,
        ForeignKey,
        Integer,
        MetaData,
        String,
        Table,
        Text,
        UniqueConstraint,
        create_engine,
        inspect,
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

    engine_url = DATABASE_URL or ""
    if engine_url.startswith("postgres://"):
        engine_url = "postgresql://" + engine_url[len("postgres://"):]

    if engine_url.startswith("postgres"):
        try:  # pragma: no cover
            import psycopg2  # type: ignore  # noqa: F401
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "psycopg2-binary должен быть установлен для подключения к Postgres"
            ) from exc

    ENGINE = create_engine(engine_url, **engine_kwargs)

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
        Column("image_url", String(512)),
        UniqueConstraint("shared_token", name="uq_pins_shared_token"),
    )

    users_table = Table(
        "users",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("nickname", String(255), nullable=False, unique=True),
        Column("password_hash", String(512), nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        UniqueConstraint("nickname", name="uq_users_nickname"),
    )

    profiles_table = Table(
        "user_profiles",
        metadata,
        Column("nickname", String(255), ForeignKey("users.nickname", ondelete="CASCADE"), primary_key=True),
        Column("age", Integer),
        Column("gender", String(16)),
        Column("avatar_path", String(512)),
        Column("reputation_points", Integer, nullable=False, server_default=text("0")),
        Column("level_up_pending", Integer, nullable=False, server_default=text("0")),
        Column("is_verified", Integer, nullable=False, server_default=text("0")),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
    )

    votes_table = Table(
        "votes",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("pin_id", Integer, ForeignKey("pins.id", ondelete="CASCADE"), nullable=False),
        Column("user_id", String(255), nullable=False),
        Column("vote_value", Integer, nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        Column("updated_at", DateTime(timezone=True), nullable=False),
        UniqueConstraint("pin_id", "user_id", name="uq_votes_pin_user"),
    )

    friendships_table = Table(
        "friendships",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("user_id", String(255), ForeignKey("users.nickname", ondelete="CASCADE"), nullable=False),
        Column("friend_id", String(255), ForeignKey("users.nickname", ondelete="CASCADE"), nullable=False),
        Column("status", String(32), nullable=False, server_default=text("'pending'"), default="pending"),
        UniqueConstraint("user_id", "friend_id", name="uq_friendships_user_friend"),
    )

    user_subscriptions_table = Table(
        "user_subscriptions",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("follower_id", String(255), ForeignKey("users.nickname", ondelete="CASCADE"), nullable=False),
        Column("author_id", String(255), ForeignKey("users.nickname", ondelete="CASCADE"), nullable=False),
        Column("created_at", DateTime(timezone=True), nullable=False),
        UniqueConstraint("follower_id", "author_id", name="uq_user_subscriptions_follower_author"),
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


    def _ensure_remote_schema_updates() -> None:
        inspector = inspect(ENGINE)
        table_names = set(inspector.get_table_names())
        for table in metadata.sorted_tables:
            if table.name in table_names:
                continue
            metadata.create_all(ENGINE, tables=[table])
            table_names.add(table.name)

        # pins: ensure image_url
        if "pins" in table_names:
            pin_columns = {col["name"] for col in inspector.get_columns("pins")}
            if "image_url" not in pin_columns:
                with ENGINE.begin() as conn:
                    conn.execute(text("ALTER TABLE pins ADD COLUMN image_url VARCHAR(512)"))

        # user_profiles: new reputation/level/verification fields
        if "user_profiles" in table_names:
            profile_columns = {col["name"] for col in inspector.get_columns("user_profiles")}
            alter_statements = []
            if "reputation_points" not in profile_columns:
                alter_statements.append("ALTER TABLE user_profiles ADD COLUMN reputation_points INTEGER DEFAULT 0 NOT NULL")
            if "level_up_pending" not in profile_columns:
                alter_statements.append("ALTER TABLE user_profiles ADD COLUMN level_up_pending INTEGER DEFAULT 0 NOT NULL")
            if "is_verified" not in profile_columns:
                alter_statements.append("ALTER TABLE user_profiles ADD COLUMN is_verified INTEGER DEFAULT 0 NOT NULL")
            if alter_statements:
                with ENGINE.begin() as conn:
                    for stmt in alter_statements:
                        conn.execute(text(stmt))


    _ensure_remote_schema_updates()
