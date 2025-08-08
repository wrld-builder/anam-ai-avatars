from fastapi import FastAPI, HTTPException, Request, Query
from pydantic import BaseModel
import os
import openai
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

# Поддержка обеих раскладок проекта (как у тебя было раньше)
try:
    from constants.models import MODEL_MAP  # старая структура
except Exception:
    from models import MODEL_MAP            # если файл лежит в корне

from stream_generator import stream_generator

app = FastAPI()

load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY", "")

async_client = openai.AsyncOpenAI()

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


@app.get("/api/generate-assistant-response")  # ВАЖНО: без завершающего /
async def generate_assistant_response(
    req: Request,
    prompt: str = Query(...),
    model: str = Query(...),
):
    # Ровно как в прошлой рабочей версии — строгая проверка Referer
    referer = req.headers.get("referer", "")
    if (not referer or not referer.startswith("https://psychology-machines.ru/")) and not referer.startswith(
        "http://localhost:5173"
    ):
        raise HTTPException(status_code=403, detail="Invalid Referer")

    # Создаём новый поток общения
    thread = await async_client.beta.threads.create()

    # Сообщение пользователя
    await async_client.beta.threads.messages.create(
        thread_id=thread.id,
        content=prompt,
        role="user",
    )

    # Запускаем стрим ассистента (как у тебя было раньше)
    stream = async_client.beta.threads.runs.stream(
        thread_id=thread.id,
        assistant_id=MODEL_MAP[model],
        tool_choice={"type": "file_search"},
    )

    # SSE-ответ
    return EventSourceResponse(
        stream_generator(stream),
        media_type="text/event-stream",
        headers={
            "x-thread-id": thread.id,
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
