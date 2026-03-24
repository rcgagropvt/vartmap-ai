"""
Semantic cache using Qdrant – returns cached responses for similar questions.
"""

import json
import hashlib
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct, Filter, FieldCondition, MatchValue

from src.config import settings
from src.utils.embeddings import embedding_model
from src.utils.redis_client import redis_pool
import structlog

log = structlog.get_logger()

qdrant = QdrantClient(host=settings.QDRANT_HOST, port=settings.QDRANT_PORT)
CACHE_COLLECTION = "semantic_cache"


async def get_cached_response(query: str, language: str, state_code: str | None = None) -> dict | None:
    """Search semantic cache for a similar query. Returns cached response or None."""
    try:
        vec = embedding_model.encode(query)

        filters = [FieldCondition(key="language", match=MatchValue(value=language))]
        if state_code:
            filters.append(FieldCondition(key="state_code", match=MatchValue(value=state_code)))

        results = qdrant.search(
            collection_name=CACHE_COLLECTION,
            query_vector=vec,
            query_filter=Filter(must=filters),
            limit=1,
            score_threshold=settings.CACHE_SIMILARITY_THRESHOLD,
        )

        if results:
            hit = results[0]
            log.debug("Semantic cache hit", score=hit.score, query=query[:80])
            return {
                "response": hit.payload.get("response"),
                "source": "semantic_cache",
                "score": hit.score,
                "original_query": hit.payload.get("query"),
            }

        return None
    except Exception as e:
        log.warn("Semantic cache lookup failed", error=str(e))
        return None


async def store_cached_response(
    query: str, response: str, language: str,
    state_code: str | None = None, feature: str = "general",
    ttl_seconds: int = None,
) -> None:
    """Store a new query-response pair in the semantic cache."""
    try:
        vec = embedding_model.encode(query)
        point_id = hashlib.md5(f"{query}:{language}:{state_code}".encode()).hexdigest()

        qdrant.upsert(
            collection_name=CACHE_COLLECTION,
            points=[
                PointStruct(
                    id=point_id,
                    vector=vec,
                    payload={
                        "query": query,
                        "response": response,
                        "language": language,
                        "state_code": state_code or "",
                        "feature": feature,
                    },
                )
            ],
        )
        log.debug("Stored in semantic cache", query=query[:80])
    except Exception as e:
        log.warn("Semantic cache store failed", error=str(e))
