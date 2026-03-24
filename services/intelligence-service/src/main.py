from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncpg
import os
import redis.asyncio as aioredis

app = FastAPI(title="VartMap Intelligence Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

db_pool = None
redis_client = None

@app.on_event("startup")
async def startup():
    global db_pool, redis_client
    try:
        db_url = os.environ.get("DATABASE_URL", "")
        if db_url and db_url != "placeholder":
            db_pool = await asyncpg.create_pool(db_url, min_size=1, max_size=5, ssl="require")
            print("Database connected")
    except Exception as e:
        print(f"Database connection error: {e}")

    try:
        redis_url = os.environ.get("REDIS_URL", "")
        if redis_url and redis_url != "placeholder":
            redis_client = aioredis.from_url(redis_url)
            print("Redis connected")
    except Exception as e:
        print(f"Redis connection error: {e}")

@app.on_event("shutdown")
async def shutdown():
    global db_pool, redis_client
    if db_pool:
        await db_pool.close()
    if redis_client:
        await redis_client.close()

@app.get("/health")
async def health():
    db_status = "connected" if db_pool else "not connected"
    redis_status = "connected" if redis_client else "not connected"
    return {
        "status": "healthy",
        "service": "intelligence-service",
        "database": db_status,
        "redis": redis_status
    }

@app.post("/api/v1/process")
async def process_message(payload: dict):
    return {
        "response": "Service is running. AI processing coming soon.",
        "intent": "unknown",
        "confidence": 0.0
    }

@app.get("/api/v1/status")
async def status():
    return {"status": "running", "service": "intelligence-service", "version": "1.0.0"}
