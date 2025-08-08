# backend/app/main.py
from fastapi import FastAPI, HTTPException, Request, Query, Response
from pydantic import BaseModel
import os
import openai
import httpx
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from starlette.responses import StreamingResponse

# MODEL_MAP может быть либо в constants/models.py, либо в models.py
try:
    from constants.models import MODEL_MAP
except Exception:
    from models import MODEL_MAP

from stream_generator import stream_generator

load_dotenv()

app = FastAPI()

# ===== OpenAI (ассистент) =====
openai.api_key = os.getenv("OPENAI_API_KEY", "")
async_client = openai.AsyncOpenAI()

# ===== Anam =====
ANAM_BASE = os.getenv("ANAM_BASE", "https://api.anam.ai")
ANAM_API_KEY = os.getenv("ANAM_API_KEY", "")

# Hop-by-hop заголовки не проксируем
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"
}

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
@app.get("/api/generate-assistant-response")  # важно: без завершающего /
async def generate_assistant_response(
    req: Request,
    prompt: str = Query(...),
    model: str = Query(...),
):
    # Жёсткая проверка Referer — как в твоей прошлой рабочей версии
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru/")) and not referer.startswith(
        "http://localhost:5173"
    ):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    # новая ветка
    thread = await async_client.beta.threads.create()

    # сообщение пользователя
    await async_client.beta.threads.messages.create(
        thread_id=thread.id,
        content=prompt,
        role="user",
    )

    # стрим ассистента (как было раньше)
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

    # ❗ httpx.Timeout: указываем все четыре
    timeout = httpx.Timeout(connect=5.0, read=30.0, write=30.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(f"{ANAM_BASE}/v1/auth/session-token", json=payload, headers=headers)
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
        )


# ========== Anam: общий прокси для /anam/api/* ==========
# Нужен для вызовов SDK: /v1/metrics/client, /v1/engine/session, и т.д.
@app.api_route("/anam/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def anam_proxy(path: str, request: Request):
    # Спец-роут /v1/auth/session-token перехвачен выше, сюда попадут все остальные
    url = f"{ANAM_BASE}/{path}"
    method = request.method

    # Проксируем заголовки (без hop-by-hop)
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}

    # Тело запроса
    body = await request.body()

    # ❗ httpx.Timeout: указываем все четыре (длинный read для SSE)
    timeout = httpx.Timeout(connect=10.0, read=600.0, write=600.0, pool=10.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            # stream-режим: корректно прокидываем и JSON, и SSE
            async with client.stream(method, url, params=request.query_params, headers=fwd_headers, content=body) as r:
                resp_headers = {k: v for k, v in r.headers.items() if k.lower() not in HOP_HEADERS}
                media = r.headers.get("content-type", None)

                # SSE — отключаем буферизацию
                if media and "text/event-stream" in media:
                    resp_headers["X-Accel-Buffering"] = "no"
                    resp_headers["Cache-Control"] = "no-cache"
                    resp_headers["Connection"] = "keep-alive"

                return StreamingResponse(
                    r.aiter_bytes(),
                    status_code=r.status_code,
                    media_type=media,
                    headers=resp_headers,
                )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Proxy error: {e}")
