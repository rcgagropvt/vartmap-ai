from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    TEMPORAL_HOST: str = "temporal:7233"
    DATABASE_URL: str = "postgresql://vartmap:vartmap@localhost:5432/vartmap"
    WA_GATEWAY_URL: str = "http://whatsapp-gateway:3000"
    REDIS_URL: str = "redis://localhost:6379"

    class Config:
        env_file = ".env"


settings = Settings()
