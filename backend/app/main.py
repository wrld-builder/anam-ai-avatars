from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel
import os
import openai
import httpx
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from starlette.responses import StreamingResponse

from models import MODEL_MAP
from stream_generator import stream_generator

load_dotenv()

# OpenAI (твой ассистент)
openai.api_key = os.getenv("OPENAI_API_KEY", "")
async_client = openai.AsyncOpenAI()

# Anam
ANAM_BASE = "https://api.anam.ai"
ANAM_API_KEY = os.getenv("ANAM_API_KEY", "")

HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"
}

app = FastAPI()

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


# ===== OpenAI SSE =====
@app.get("/api/generate-assistant-response")
async def generate_assistant_response(
    req: Request,
    prompt: str,
    model: str,
    thread_id: str | None = None,
    use_search: bool = False,
):
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru")) and not referer.startswith("http://localhost:5173"):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    t_id = thread_id
    if not t_id:
        thread = await async_client.beta.threads.create()
        t_id = thread.id

    await async_client.beta.threads.messages.create(
        thread_id=t_id, content=prompt, role="user",
    )

    stream = async_client.beta.threads.runs.stream(
        thread_id=t_id,
        assistant_id=MODEL_MAP[model],
        tool_choice="none" if not use_search else "auto",
    )

    headers = {
        "x-thread-id": t_id,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return EventSourceResponse(stream_generator(stream), media_type="text/event-stream", headers=headers)


# ===== Anam: session-token (через наш ключ) =====
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

    async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5)) as client:
        r = await client.post(f"{ANAM_BASE}/v1/auth/session-token", json=payload, headers=headers)
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
        )


# ===== Anam: GENERAL PROXY for /anam/api/*  (включая /v1/engine/session, /v1/client, и т.д.) =====
@app.api_route("/anam/api/{path:path}", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS"])
async def anam_proxy(path: str, request: Request):
    # Специальный /v1/auth/session-token перехвачен выше; сюда попадают все остальные пути.
    url = f"{ANAM_BASE}/{path}"
    method = request.method

    # исходные заголовки (без hop-by-hop)
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}

    # тело запроса
    body = await request.body()

    timeout = httpx.Timeout(connect=10.0, read=600.0)  # длинный read для SSE
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            # stream-режим: чтобы корректно прокидывать SSE/длинные ответы
            async with client.stream(method, url, params=request.query_params, headers=fwd_headers, content=body) as r:
                resp_headers = {k: v for k, v in r.headers.items() if k.lower() not in HOP_HEADERS}
                media = r.headers.get("content-type", None)

                # Для SSE отключаем буферизацию
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
