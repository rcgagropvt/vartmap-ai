# intelligence-service/src/engine/rag_pipeline.py

from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue
from sentence_transformers import SentenceTransformer
import openai
from typing import Optional


class RAGPipeline:
    """
    Retrieval-Augmented Generation pipeline.
    Only triggered when rule engine can't handle the query.
    """

    def __init__(self, config):
        self.qdrant = QdrantClient(
            host=config.QDRANT_HOST,
            port=config.QDRANT_PORT
        )
        self.embedder = SentenceTransformer(
            'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'
        )
        self.openai_client = openai.AsyncOpenAI(api_key=config.OPENAI_API_KEY)
        self.config = config

    async def process(self, query: str, farmer_context: dict,
                      language: str = 'hi') -> RoutingResult:
        """
        Full RAG pipeline:
        1. Embed query
        2. Retrieve relevant chunks from Qdrant
        3. Build prompt with context
        4. Generate response via LLM
        5. Validate and format
        """
        # 1. Embed the query
        query_embedding = self.embedder.encode(query).tolist()

        # 2. Retrieve from multiple collections with metadata filtering
        filters = []
        if farmer_context.get('crops'):
            filters.append(
                FieldCondition(key="crop", match=MatchValue(value=farmer_context['crops'][0]))
            )
        if farmer_context.get('state'):
            filters.append(
                FieldCondition(key="region", match=MatchValue(value=farmer_context['state']))
            )

        qdrant_filter = Filter(should=filters) if filters else None

        # Search across relevant collections
        collections_to_search = ['crop_advisory', 'pest_disease', 'product_knowledge']
        all_chunks = []

        for collection in collections_to_search:
            try:
                results = self.qdrant.search(
                    collection_name=collection,
                    query_vector=query_embedding,
                    query_filter=qdrant_filter,
                    limit=3,
                    score_threshold=0.5
                )
                for r in results:
                    all_chunks.append({
                        'text': r.payload.get('text', ''),
                        'source': collection,
                        'score': r.score,
                        'metadata': r.payload
                    })
            except Exception:
                continue

        # Sort by relevance score, take top 5
        all_chunks.sort(key=lambda x: x['score'], reverse=True)
        context_chunks = all_chunks[:5]

        # 3. Build the prompt
        context_text = "\n\n".join([c['text'] for c in context_chunks])

        # Determine model based on complexity
        model = self._select_model(query, context_chunks)

        system_prompt = self._build_system_prompt(farmer_context, language)
        user_prompt = self._build_user_prompt(query, context_text, language)

        # 4. Generate response
        response = await self.openai_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            max_tokens=300 if model == 'gpt-4o-mini' else 500,
            temperature=0.3
        )

        answer = response.choices[0].message.content
        usage = response.usage

        # 5. Calculate cost
        if model == 'gpt-4o-mini':
            cost = (usage.prompt_tokens * 0.15 + usage.completion_tokens * 0.60) / 1_000_000
        else:  # gpt-4o
            cost = (usage.prompt_tokens * 2.50 + usage.completion_tokens * 10.00) / 1_000_000

        # 6. Append disclaimer
        disclaimer = {
            'hi': "\n\n⚠️ Yeh salah samanya jaankari ke liye hai. "
                  "Apne local KVK ya krishi adhikari se bhi salah lein.",
            'en': "\n\n⚠️ This advice is for general information. "
                  "Please also consult your local KVK or agriculture officer."
        }[language]

        answer += disclaimer

        return RoutingResult(
            response_text=answer,
            layer=ProcessingLayer.RAG_AI,
            confidence=0.85,
            model_used=model,
            tokens_input=usage.prompt_tokens,
            tokens_output=usage.completion_tokens,
            cost_usd=cost,
            disclaimer_appended=True
        )

    def _select_model(self, query: str, chunks: list) -> str:
        """Select GPT-4o-mini for simple queries, GPT-4o for complex."""
        # Heuristics for complexity
        word_count = len(query.split())
        has_multiple_questions = query.count('?') > 1
        low_retrieval_scores = all(c['score'] < 0.65 for c in chunks) if chunks else True

        if has_multiple_questions or word_count > 30 or low_retrieval_scores:
            return 'gpt-4o'
        return 'gpt-4o-mini'

    def _build_system_prompt(self, context: dict, language: str) -> str:
        lang_instruction = {
            'hi': "Respond ONLY in Hindi (Devanagari script).",
            'bho': "Respond in Bhojpuri using Devanagari script.",
            'en': "Respond in simple English."
        }[language]

        return f"""You are Krishi Sahayak, an expert agricultural advisor for Indian farmers.

{lang_instruction}

Farmer profile:
- Name: {context.get('name', 'Farmer')}
- District: {context.get('district', 'Unknown')}
- State: {context.get('state', 'Unknown')}
- Crops: {', '.join(context.get('crops', ['Unknown']))}
- Land: {context.get('land_bigha', 'Unknown')} bigha
- Soil type: {context.get('soil_type', 'Unknown')}
- Current season: {context.get('season', 'Unknown')}

Rules:
1. Keep answers practical, specific, and actionable
2. Include dosage amounts per bigha when recommending inputs
3. Include timing (when to apply)
4. Include safety precautions for any chemical recommendation
5. If you're not confident, say so clearly
6. NEVER recommend banned pesticides
7. Keep response under 250 words
8. Use simple language that a farmer with basic education can understand"""

    def _build_user_prompt(self, query: str, context: str, language: str) -> str:
        return f"""Farmer's question: {query}

Relevant knowledge base information:
{context}

Based on the above information and your agricultural expertise, provide a helpful answer to the farmer's question. If the knowledge base doesn't contain relevant information, use your general agricultural knowledge but indicate lower confidence."""

    async def analyze_image(self, image_data: bytes, farmer_context: dict):
        """Analyze crop image using GPT-4o Vision."""
        import base64
        b64_image = base64.b64encode(image_data).decode('utf-8')

        crops = farmer_context.get('crops', ['crop'])
        district = farmer_context.get('district', 'district')

        response = await self.openai_client.chat.completions.create(
            model='gpt-4o',
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert plant pathologist and entomologist "
                        "specializing in Indian agriculture. Analyze the crop image "
                        "and provide structured diagnosis."
                    )
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"This is a photo from a farmer in {district} district "
                                f"growing {', '.join(crops)}. "
                                "Identify any disease, pest, or deficiency visible. "
                                "Respond in JSON format: "
                                '{"disease": "name", "confidence": 0.0-1.0, '
                                '"severity": "mild/moderate/severe", '
                                '"affected_area_pct": 0-100, '
                                '"recommended_action": "specific steps", '
                                '"chemical_name": "generic name", '
                                '"dosage_per_bigha": "amount", '
                                '"safety_precautions": "PPE and precautions"}'
                            )
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{b64_image}",
                                "detail": "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens=500,
            temperature=0.2
        )

        # Parse structured response
        import json
        try:
            result = json.loads(response.choices[0].message.content)
        except json.JSONDecodeError:
            result = {
                "disease": "Unknown",
                "confidence": 0.3,
                "severity": "unknown",
                "recommended_action": response.choices[0].message.content
            }

        usage = response.usage
        cost = (usage.prompt_tokens * 2.50 + usage.completion_tokens * 10.00) / 1_000_000

        from dataclasses import dataclass
        @dataclass
        class ImageAnalysisResult:
            result_primary: str = result.get('disease', 'Unknown')
            confidence: float = result.get('confidence', 0.5)
            severity: str = result.get('severity', 'unknown')
            affected_area_pct: float = result.get('affected_area_pct', 0)
            recommended_action: str = result.get('recommended_action', '')
            chemical_name: str = result.get('chemical_name', '')
            dosage: str = result.get('dosage_per_bigha', '')
            safety: str = result.get('safety_precautions', '')
            model_used: str = 'gpt-4o'
            tokens_input: int = usage.prompt_tokens
            tokens_output: int = usage.completion_tokens
            cost_usd: float = cost
            products_recommended: list = None

        return ImageAnalysisResult()
