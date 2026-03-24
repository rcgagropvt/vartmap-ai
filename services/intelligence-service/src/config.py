from pydantic_settings import BaseSettings
from typing import List, Optional


class Settings(BaseSettings):
    # Database
    DATABASE_URL: str = "postgresql://vartmap:vartmap@localhost:5432/vartmap"
    DB_POOL_MIN: int = 5
    DB_POOL_MAX: int = 20

    # Redis
    REDIS_URL: str = "redis://localhost:6379"

    # OpenAI
    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o"
    OPENAI_MINI_MODEL: str = "gpt-4o-mini"
    AI_MONTHLY_BUDGET_INR: float = 15000.0
    AI_COST_PER_1K_INPUT: float = 0.15   # gpt-4o-mini INR approx
    AI_COST_PER_1K_OUTPUT: float = 0.60

    # Qdrant
    QDRANT_HOST: str = "qdrant"
    QDRANT_PORT: int = 6333
    QDRANT_COLLECTION: str = "krishi_knowledge"
    EMBEDDING_MODEL: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    EMBEDDING_DIM: int = 384

    # WhatsApp Gateway
    WA_GATEWAY_URL: str = "http://whatsapp-gateway:3000"

    # External APIs
    AGMARKNET_BASE_URL: str = "https://agmarknet.gov.in"
    OPENWEATHER_API_KEY: str = ""
    OPENWEATHER_BASE_URL: str = "https://api.openweathermap.org/data/3.0"

    # Semantic cache
    CACHE_SIMILARITY_THRESHOLD: float = 0.92
    CACHE_TTL_SECONDS: int = 3600

    # Rate limiting
    FARMER_AI_QUERIES_PER_DAY: int = 20
    FARMER_IMAGE_ANALYSES_PER_DAY: int = 5

    # CORS
    CORS_ORIGINS: List[str] = ["*"]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
