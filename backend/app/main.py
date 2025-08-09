from fastapi import FastAPI, HTTPException, Request, Query, Response
from pydantic import BaseModel
import os
import time
import asyncio
import openai
import httpx
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from starlette.responses import StreamingResponse

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

# ==== Глобальный httpx-клиент (keep-alive + HTTP/2) для прокси Anam ====
@app.on_event("startup")
async def _startup():
  app.state.httpx_client = httpx.AsyncClient(
      http2=True,
      timeout=httpx.Timeout(connect=5.0, read=600.0, write=600.0, pool=5.0),
      headers={"Accept-Encoding": "identity"},
  )

@app.on_event("shutdown")
async def _shutdown():
  try:
      await app.state.httpx_client.aclose()
  except Exception:
      pass

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
    allow_headers=["*", "X-API-KEY", "Authorization", "Content-Type"],
)

class PromptRequest(BaseModel):
    prompt: str

# ====== Предсоздание thread (ускоряет первый ответ) ======
@app.post("/api/thread/new")
async def create_thread(req: Request, model: str = Query(...)):
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru/")) and not referer.startswith("http://localhost:5173"):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    thread = await async_client.beta.threads.create()
    return {"thread_id": thread.id}


# ========== OpenAI SSE (File Search ВСЕГДА, thread_id реюз) ==========
@app.get("/api/generate-assistant-response")  # важно: без завершающего /
async def generate_assistant_response(
    req: Request,
    prompt: str = Query(...),
    model: str = Query(...),
    thread_id: str | None = Query(None),
):
    # Проверка Referer — как в твоей рабочей версии
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru/")) and not referer.startswith(
        "http://localhost:5173"
    ):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    # тред: реюз если пришёл, иначе создаём
    if thread_id:
        t_id = thread_id
    else:
        thread = await async_client.beta.threads.create()
        t_id = thread.id

    # сообщение пользователя
    await async_client.beta.threads.messages.create(
        thread_id=t_id,
        content=prompt,
        role="user",
    )

    # стрим ассистента — File Search ВСЕГДА «присутствует»
    stream = async_client.beta.threads.runs.stream(
        thread_id=t_id,
        assistant_id=MODEL_MAP[model],
        tool_choice={"type": "file_search"},
    )

    # сперва отправим THREAD_ID, потом контент
    async def combined_stream():
        yield f"__THREAD_ID__:{t_id}"
        async for chunk in stream_generator(stream):
            yield chunk

    return EventSourceResponse(
        combined_stream(),
        media_type="text/event-stream",
        headers={
            "x-thread-id": t_id,
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


# ========== Anam: session-token с кэшем (минус 150–400 мс) ==========
TOKEN_TTL = int(os.getenv("ANAM_TOKEN_TTL", "600"))  # секунд
TOKEN_CACHE: dict[str, tuple[str, float]] = {}       # personaId -> (token, exp_ts)

@app.post("/anam/api/v1/auth/session-token")
async def anam_session_token(req: Request):
    if not ANAM_API_KEY:
        raise HTTPException(status_code=500, detail="ANAM_API_KEY is not set")

    try:
        payload = await req.json()
    except Exception:
        payload = {}

    persona_id = (payload.get("personaConfig") or {}).get("personaId", "default")
    now = time.time()
    cached = TOKEN_CACHE.get(persona_id)
    if cached and cached[1] > now + 30:  # небольшой запас до истечения
        return Response(
            content=f'{{"sessionToken":"{cached[0]}"}}',
            media_type="application/json",
        )

    headers = {
        "Authorization": f"Bearer {ANAM_API_KEY}",
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
    }

    client: httpx.AsyncClient = app.state.httpx_client
    r = await client.post(f"{ANAM_BASE}/v1/auth/session-token", json=payload, headers=headers)

    # если успех — положим в кэш
    if r.status_code // 100 == 2:
        try:
            data = r.json()
            token = data.get("sessionToken", "")
            if token:
                TOKEN_CACHE[persona_id] = (token, now + TOKEN_TTL)
        except Exception:
            pass

    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "application/json"),
    )


# ========== Anam: общий прокси для /anam/api/* ==========
@app.api_route("/anam/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def anam_proxy(path: str, request: Request):
    """
    Стабильный и быстрый стриминг-прокси:
    - OPTIONS → 204 (CORS preflight не идёт в апстрим)
    - client.send(..., stream=True) + асинхр. генератор
    - ловим ReadError/CancelledError и завершаем мягко
    - HTTP/2 + keep-alive + identity (без gzip) для минимальной задержки
    """
    if request.method == "OPTIONS":
        return Response(status_code=204)

    url = f"{ANAM_BASE}/{path}"
    method = request.method

    # Проксируем заголовки (без hop-by-hop)
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}
    # без gzip — меньше проблем со стримом
    fwd_headers["Accept-Encoding"] = "identity"

    # Тело запроса
    body = await request.body()

    client: httpx.AsyncClient = app.state.httpx_client
    try:
        req_up = client.build_request(
            method, url, params=request.query_params, headers=fwd_headers, content=body
        )
        r = await client.send(req_up, stream=True)

        media = r.headers.get("content-type") or "application/octet-stream"
        resp_headers = {k: v for k, v in r.headers.items() if k.lower() not in HOP_HEADERS}

        # SSE — отключаем буферизацию
        if "text/event-stream" in media:
            resp_headers["X-Accel-Buffering"] = "no"
            resp_headers["Cache-Control"] = "no-cache"
            resp_headers["Connection"] = "keep-alive"

        async def iter_response():
            try:
                async for chunk in r.aiter_bytes():
                    if isinstance(chunk, str):
                        chunk = chunk.encode("utf-8", "ignore")
                    yield chunk
            except (httpx.ReadError, asyncio.CancelledError):
                return
            finally:
                await r.aclose()

        return StreamingResponse(
            iter_response(),
            status_code=r.status_code,
            media_type=media,
            headers=resp_headers,
        )
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Proxy error: {e}")
