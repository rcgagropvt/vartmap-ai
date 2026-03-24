import redis.asyncio as redis
from src.config import settings
import structlog

log = structlog.get_logger()


class RedisPool:
    def __init__(self):
        self.client: redis.Redis | None = None

    async def initialize(self):
        self.client = redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            max_connections=20,
        )
        await self.client.ping()
        log.info("Redis connected")

    async def close(self):
        if self.client:
            await self.client.aclose()
            log.info("Redis closed")

    async def get(self, key: str) -> str | None:
        return await self.client.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        await self.client.set(key, value, ex=ex)

    async def incr(self, key: str) -> int:
        return await self.client.incr(key)

    async def expire(self, key: str, seconds: int):
        await self.client.expire(key, seconds)


redis_pool = RedisPool()
