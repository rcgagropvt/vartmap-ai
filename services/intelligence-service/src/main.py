"""
VartMap Intelligence Service – main FastAPI application.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import make_asgi_app

from src.config import settings
from src.utils.logging import setup_logging
from src.utils.db import db_pool
from src.utils.redis_client import redis_pool
from src.utils.embeddings import embedding_model
from src.routes import process, health, admin, mandi, weather, schemes

logger = setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    logger.info("Starting Intelligence Service", version="1.0.0")
    await db_pool.initialize()
    await redis_pool.initialize()
    embedding_model.load()
    logger.info("All resources initialized")
    yield
    await db_pool.close()
    await redis_pool.close()
    logger.info("Intelligence Service stopped")


app = FastAPI(
    title="VartMap Intelligence Service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Prometheus metrics endpoint
metrics_app = make_asgi_app()
app.mount("/metrics", metrics_app)

# Routes
app.include_router(health.router, tags=["health"])
app.include_router(process.router, prefix="/api/v1", tags=["process"])
app.include_router(mandi.router, prefix="/api/v1/mandi", tags=["mandi"])
app.include_router(weather.router, prefix="/api/v1/weather", tags=["weather"])
app.include_router(schemes.router, prefix="/api/v1/schemes", tags=["schemes"])
app.include_router(admin.router, prefix="/api/v1/admin", tags=["admin"])
