import asyncpg
from src.config import settings

import structlog

log = structlog.get_logger()


class DBPool:
    def __init__(self):
        self.pool: asyncpg.Pool | None = None

    async def initialize(self):
        self.pool = await asyncpg.create_pool(
            dsn=settings.DATABASE_URL,
            min_size=settings.DB_POOL_MIN,
            max_size=settings.DB_POOL_MAX,
            command_timeout=30,
        )
        log.info("PostgreSQL pool initialized", min=settings.DB_POOL_MIN, max=settings.DB_POOL_MAX)

    async def close(self):
        if self.pool:
            await self.pool.close()
            log.info("PostgreSQL pool closed")

    async def fetch(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetch(query, *args)

    async def fetchrow(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetchrow(query, *args)

    async def fetchval(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.fetchval(query, *args)

    async def execute(self, query: str, *args):
        async with self.pool.acquire() as conn:
            return await conn.execute(query, *args)


db_pool = DBPool()
