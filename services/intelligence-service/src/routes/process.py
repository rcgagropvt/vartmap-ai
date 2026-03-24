"""
Main processing endpoint – receives messages from WhatsApp Gateway,
routes through rule engine or AI pipeline, sends response back.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional, List
import time

from src.engine.router import route_message
from src.utils.logging import setup_logging

log = setup_logging()
router = APIRouter()


class InboundPayload(BaseModel):
    farmerId: str
    phone: str
    bsuid: Optional[str] = None
    conversationId: str
    messageId: str
    messageType: str
    content: str
    language: str = "hi"
    state: Optional[str] = None
    district: Optional[str] = None
    crops: List[str] = []
    onboardingComplete: bool = True
    context: Optional[dict] = None
    timestamp: Optional[str] = None


@router.post("/process")
async def process_message(payload: InboundPayload):
    start = time.time()

    try:
        result = await route_message(payload)
        elapsed_ms = int((time.time() - start) * 1000)

        log.info(
            "Message processed",
            farmer_id=payload.farmerId,
            feature=result.get("feature", "unknown"),
            source=result.get("source", "unknown"),
            latency_ms=elapsed_ms,
        )

        return {
            "status": "ok",
            "feature": result.get("feature"),
            "source": result.get("source"),
            "latency_ms": elapsed_ms,
        }
    except Exception as e:
        log.error("Processing failed", farmer_id=payload.farmerId, error=str(e))
        raise HTTPException(status_code=500, detail=str(e))
