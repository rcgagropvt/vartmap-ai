"""
RAG-based AI pipeline for complex queries that rules can't handle.
"""

import json
from openai import AsyncOpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

from src.config import settings
from src.utils.embeddings import embedding_model
from src.utils.cost_tracker import track_ai_cost
from src.utils.logging import setup_logging

log = setup_logging()

openai_client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
qdrant = QdrantClient(host=settings.QDRANT_HOST, port=settings.QDRANT_PORT)

SYSTEM_PROMPT_HI = """तुम VartMap कृषि सहायक हो — भारतीय किसानों के लिए एक विश्वसनीय कृषि सलाहकार।

नियम:
1. हमेशा वैज्ञानिक और सत्यापित जानकारी दो
2. ICAR, KVK, और राज्य कृषि विभाग के दिशानिर्देशों का पालन करो
3. उत्तर संक्षिप्त रखो (WhatsApp के लिए उपयुक्त)
4. जहां जरूरी हो, खुराक और मात्रा स्पष्ट बताओ
5. अनिश्चित हो तो स्पष्ट कहो "मुझे इसकी पक्की जानकारी नहीं है"
6. कभी भी बिना प्रमाण के दवाई/रसायन की सिफारिश मत करो
7. किसान की भाषा में आसानी से समझ आने वाले शब्दों का प्रयोग करो"""

SYSTEM_PROMPT_EN = """You are VartMap Krishi Sahayak — a trusted agricultural advisor for Indian farmers.

Rules:
1. Always provide scientifically verified information
2. Follow ICAR, KVK, and state agriculture department guidelines
3. Keep answers concise (suitable for WhatsApp)
4. Clearly state dosage and quantities where relevant
5. If uncertain, explicitly say "I'm not sure about this"
6. Never recommend chemicals without evidence
7. Use simple language a farmer can understand"""


async def run_ai_pipeline(payload) -> dict:
    """Execute the full RAG pipeline: retrieve → generate → respond."""
    farmer_id = payload.farmerId
    content = payload.content
    language = payload.language

    # ── 1. Retrieve relevant knowledge ─────────────────────
    context_chunks = await retrieve_knowledge(content, language, payload.state)

    # ── 2. Determine model (mini for simple, full for complex) ──
    model = settings.OPENAI_MINI_MODEL
    if payload.messageType == "image" or len(content) > 200:
        model = settings.OPENAI_MODEL

    # ── 3. Build messages ──────────────────────────────────
    system_prompt = SYSTEM_PROMPT_HI if language == "hi" else SYSTEM_PROMPT_EN
    context_text = "\n\n".join([f"[{c['source']}]: {c['text']}" for c in context_chunks])

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "system", "content": f"Relevant knowledge:\n{context_text}" if context_text else "No specific knowledge found. Answer from general agricultural knowledge."},
        {"role": "user", "content": f"Farmer's question ({language}): {content}\n\nFarmer details: State={payload.state}, District={payload.district}, Crops={payload.crops}"},
    ]

    # ── 4. Handle image messages ───────────────────────────
    if payload.messageType == "image" and hasattr(payload, "image_url"):
        model = settings.OPENAI_MODEL  # Need vision model
        messages[-1] = {
            "role": "user",
            "content": [
                {"type": "text", "text": f"Farmer sent this image of their crop. Identify any disease/pest and provide treatment advice. State={payload.state}, Crops={payload.crops}"},
                {"type": "image_url", "image_url": {"url": payload.image_url, "detail": "high"}},
            ],
        }

    # ── 5. Generate response ───────────────────────────────
    try:
        completion = await openai_client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=800,
            temperature=0.3,
        )

        response_text = completion.choices[0].message.content
        usage = completion.usage

        # ── 6. Track cost ──────────────────────────────────
        cost_info = await track_ai_cost(
            farmer_id=farmer_id,
            feature="ai_query" if payload.messageType != "image" else "image_analysis",
            input_tokens=usage.prompt_tokens,
            output_tokens=usage.completion_tokens,
            model=model,
        )

        # ── 7. Send response ──────────────────────────────
        from src.engine.router import send_response
        await send_response(payload, response_text)

        return {
            "feature": "ai_general" if payload.messageType != "image" else "image_analysis",
            "source": "ai_pipeline",
            "model": model,
            "response": response_text,
            "cost": cost_info,
        }

    except Exception as e:
        log.error("AI pipeline error", error=str(e), farmer_id=farmer_id)
        from src.engine.router import send_response
        fallback = (
            "क्षमा करें, अभी AI सेवा में समस्या है। कृपया बाद में प्रयास करें।"
            if language == "hi"
            else "Sorry, there's an issue with our AI service. Please try again later."
        )
        await send_response(payload, fallback)
        return {"feature": "ai_error", "source": "ai_pipeline", "error": str(e)}


async def retrieve_knowledge(query: str, language: str, state: str | None) -> list[dict]:
    """Retrieve relevant chunks from Qdrant knowledge base."""
    try:
        vec = embedding_model.encode(query)

        filters = []
        if state:
            filters.append(FieldCondition(key="state_code", match=MatchValue(value=state)))

        results = qdrant.search(
            collection_name=settings.QDRANT_COLLECTION,
            query_vector=vec,
            query_filter=Filter(must=filters) if filters else None,
            limit=5,
            score_threshold=0.5,
        )

        chunks = []
        for r in results:
            chunks.append({
                "text": r.payload.get("text", ""),
                "source": r.payload.get("source", "unknown"),
                "score": r.score,
            })

        return chunks
    except Exception as e:
        log.warn("Knowledge retrieval failed", error=str(e))
        return []
