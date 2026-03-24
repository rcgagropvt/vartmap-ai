import numpy as np
from sentence_transformers import SentenceTransformer
from src.config import settings
import structlog

log = structlog.get_logger()


class EmbeddingModel:
    def __init__(self):
        self.model: SentenceTransformer | None = None

    def load(self):
        log.info("Loading embedding model", model=settings.EMBEDDING_MODEL)
        self.model = SentenceTransformer(settings.EMBEDDING_MODEL)
        log.info("Embedding model loaded", dim=settings.EMBEDDING_DIM)

    def encode(self, text: str) -> list[float]:
        if not self.model:
            raise RuntimeError("Embedding model not loaded")
        vec = self.model.encode(text, normalize_embeddings=True)
        return vec.tolist()

    def encode_batch(self, texts: list[str]) -> list[list[float]]:
        if not self.model:
            raise RuntimeError("Embedding model not loaded")
        vecs = self.model.encode(texts, normalize_embeddings=True, batch_size=32)
        return vecs.tolist()


embedding_model = EmbeddingModel()
