import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


def database_url() -> str:
    url = os.environ.get("DATABASE_URL", "sqlite:///shelfmark.db")
    # Neon hands out postgres:// / postgresql:// URLs; SQLAlchemy needs the psycopg 3 driver named.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url.removeprefix(prefix)
    return url


URL = database_url()
# Neon's pooler (PgBouncer, transaction mode) can't share server-side prepared statements.
engine = create_engine(
    URL,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={"prepare_threshold": None} if URL.startswith("postgresql") else {},
)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass
