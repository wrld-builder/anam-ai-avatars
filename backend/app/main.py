# backend/app/main.py
from fastapi import FastAPI, HTTPException, Request, Query, Response
from pydantic import BaseModel
import os
import openai
import httpx
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

# MODEL_MAP может быть либо в constants/models.py, либо в models.py
try:
    from constants.models import MODEL_MAP
except Exception:
    from models import MODEL_MAP

from stream_generator import stream_generator

app = FastAPI()

load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY", "")
async_client = openai.AsyncOpenAI()

# --- Anam ---
ANAM_BASE = "https://api.anam.ai"
ANAM_API_KEY = os.getenv("ANAM_API_KEY", "")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://psychology-machines.ru",
        "https://www.psychology-machines.ru",
        "https://87.239.251.126",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*", "X-API-KEY"],
)

class PromptRequest(BaseModel):
    prompt: str

# ========== OpenAI SSE ==========
@app.get("/api/generate-assistant-response")  # Важно: без завершающего /
async def generate_assistant_response(
    req: Request,
    prompt: str = Query(...),
    model: str = Query(...),
):
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru/")) and not referer.startswith(
        "http://localhost:5173"
    ):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    # новая ветка диалога
    thread = await async_client.beta.threads.create()

    # сообщение пользователя
    await async_client.beta.threads.messages.create(
        thread_id=thread.id,
        content=prompt,
        role="user",
    )

    # стрим ответа ассистента — как в твоей прошлой рабочей версии
    stream = async_client.beta.threads.runs.stream(
        thread_id=thread.id,
        assistant_id=MODEL_MAP[model],
        tool_choice={"type": "file_search"},
    )

    return EventSourceResponse(
        stream_generator(stream),
        media_type="text/event-stream",
        headers={
            "x-thread-id": thread.id,
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )

# ========== Anam: только session-token ==========
@app.post("/anam/api/v1/auth/session-token")
async def anam_session_token(req: Request):
    """
    Проксируем выдачу session-token в Anam, чтобы ключ не светился в браузере.
    Фронт бьёт сюда: /anam/api/v1/auth/session-token
    """
    if not ANAM_API_KEY:
        raise HTTPException(status_code=500, detail="ANAM_API_KEY is not set")

    try:
        payload = await req.json()
    except Exception:
        payload = {}

    headers = {
        "Authorization": f"Bearer {ANAM_API_KEY}",
        "Content-Type": "application/json",
    }

    timeout = httpx.Timeout(30.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(f"{ANAM_BASE}/v1/auth/session-token", json=payload, headers=headers)
        # Пробрасываем ответ как есть (код + content-type)
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
        )
