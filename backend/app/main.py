from fastapi import FastAPI, HTTPException, Request, Query, Response
from pydantic import BaseModel
import openai
import os
import httpx
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from typing import Optional
from starlette.responses import StreamingResponse

from models import MODEL_MAP
from stream_generator import stream_generator

load_dotenv()

openai.api_key = os.getenv("OPENAI_API_KEY")
async_client = openai.AsyncOpenAI()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://psychology-machines.ru",
        "https://87.239.251.126",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*", "X-API-KEY"],
)

class PromptRequest(BaseModel):
    prompt: str

@app.get("/api/generate-assistant-response")
async def generate_assistant_response(
    req: Request,
    prompt: str = Query(...),
    model: str = Query(...),
    thread_id: Optional[str] = Query(None),
    use_search: bool = Query(True),
):
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru/")) and not referer.startswith("http://localhost:5173"):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    t_id = thread_id or (await async_client.beta.threads.create()).id

    await async_client.beta.threads.messages.create(
        thread_id=t_id, content=prompt, role="user"
    )

    stream = async_client.beta.threads.runs.stream(
        thread_id=t_id,
        assistant_id=MODEL_MAP.get(model, MODEL_MAP["MARIA_MODEL"]),
        tool_choice=("auto" if use_search else "none"),
    )

    return EventSourceResponse(
        stream_generator(stream),
        media_type="text/event-stream",
        headers={
            "x-thread-id": t_id,
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

# ===== Anam proxy =====
ANAM_BASE = "https://api.anam.ai"
ANAM_API_KEY = os.getenv("ANAM_API_KEY", "")

@app.post("/anam/api/v1/auth/session-token")
async def anam_session_token(req: Request):
    if not ANAM_API_KEY:
        raise HTTPException(status_code=500, detail="ANAM_API_KEY is not set on server")
    try:
        payload = await req.json()
    except Exception:
        payload = {}
    headers = {
        "Authorization": f"Bearer {ANAM_API_KEY}",
        "x-anam-api-key": ANAM_API_KEY,
        "x-api-key": ANAM_API_KEY,
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5)) as client:
        r = await client.post(f"{ANAM_BASE}/v1/auth/session-token", json=payload, headers=headers)
        return Response(content=r.content, status_code=r.status_code, media_type=r.headers.get("content-type","application/json"))

@app.api_route("/anam/api/{full_path:path}", methods=["GET","POST","PUT","PATCH","DELETE","OPTIONS"])
async def anam_proxy(full_path: str, request: Request):
    """
    Универсальный прокси на https://api.anam.ai/*.
    - /v1/auth/session-token: добавляем API-ключ (Bearer + x-headers).
    - Все прочие эндпоинты: НЕ трогаем Authorization и НЕ добавляем x-headers —
      SDK сам шлёт Bearer <sessionToken>.
    """
    if not ANAM_API_KEY:
        raise HTTPException(status_code=500, detail="ANAM_API_KEY is not set on server")

    upstream_url = f"{ANAM_BASE}/{full_path}"
    params = dict(request.query_params)
    body = await request.body()

    # Скопируем входные заголовки, убрав hop-by-hop
    hop = {"host","content-length","connection","keep-alive",
           "proxy-authenticate","proxy-authorization","te",
           "trailers","transfer-encoding","upgrade"}
    headers = {k: v for k, v in request.headers.items() if k.lower() not in hop}

    # Если идём за session-token — подставляем API ключи
    if full_path.startswith("v1/auth/session-token"):
        headers["Authorization"] = f"Bearer {ANAM_API_KEY}"
        headers["x-anam-api-key"] = ANAM_API_KEY
        headers["x-api-key"] = ANAM_API_KEY
        headers.setdefault("Content-Type", "application/json")
    else:
        # Для всех остальных путей НЕ трогаем Authorization (он может быть sessionToken или отсутствовать),
        # и НЕ добавляем x-* ключи.
        for h in ["x-anam-api-key", "x-api-key"]:
            headers.pop(h, None)

    timeout = httpx.Timeout(60.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.request(request.method, upstream_url,
                                 params=params, headers=headers, content=body)
        # Вернём ответ как есть, не ломая тип
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "application/json"),
            headers={k: v for k, v in r.headers.items()
                     if k.lower() not in {"content-encoding","transfer-encoding","connection","keep-alive","server"}}
        )

