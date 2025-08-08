# Аватар‑психолог (Anam.ai + FastAPI + OpenAI) — низкая задержка

Этот проект даёт готовый стек для стримингового аватара на сайте:
- Видео/аудио — **Anam.ai WebRTC SDK** (минимальная задержка)
- Текст — **OpenAI** (два варианта): ваш текущий Assistants API *или* быстрый Chat API
- Передача текста в аватар — **TalkMessageStream** (стрим токенов по мере генерации)

## Архитектура латентности

1. Браузер устанавливает **WebRTC**‑соединение с Anam → видео аватара идёт напрямую в `<video>`.
2. LLM **НЕ** запускается в Anam (llmId=CUSTOMER_CLIENT_V1) — мы стримим свой текст в аватар с микрозадержкой.
3. Бэкенд (FastAPI) стримит токены из OpenAI (SSE) → фронтенд сразу «льёт» их в `talkMessageStream`.
4. Nginx настроен на **proxy_buffering off** для SSE.

## Запуск

### 1) Бэкенд

```bash
cd backend
cp .env.example .env   # заполните ключи
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
./run.sh    # или: uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Проверка:
- `GET /health` → `{"status":"ok"}`
- `POST /api/anam/session-token` → отдаёт `{ sessionToken }`

> **Важно (Nginx)**: добавьте `nginx.sse.conf` в ваш серверный блок, чтобы SSE не буферизовался.

### 2) Фронтенд

```bash
cd frontend
npm i
npm run dev   # http://localhost:5173
```

Кнопка «Подключить» создаёт сессию Anam, видео пойдёт в `<video>`.  
Поле ввода отправляет текст, который **стримится** в аватар (минимальная задержка).

## Настройки персоны

Переменные окружения бэкенда:
- `ANAM_AVATAR_ID`, `ANAM_VOICE_ID` — выберите в галереях (см. ссылки ниже).
- `ANAM_LLM_ID=CUSTOMER_CLIENT_V1` — отключает мозг Anam (мы шлём свой текст).
- `SYSTEM_PROMPT` — стиль психолога (CBT, эмпатия, краткость).

## Как добиться ещё меньшей задержки

- **Переиспользуйте thread_id** (параметр `thread_id` в `/api/generate-assistant-response`) — мы уже это делаем: фронт подхватывает id и передаёт в следующие запросы. Первый запрос создаёт тред, последующие — нет лишней инициализации.
- **Отключите инструменты** в Assistants (file_search и т.п.) — это снижает подготовительные шаги (реализовано).
- **Микро-батчинг** токенов 40–70мс + «сбрасывать» на пунктуации — уже сделано в `frontend/src/main.ts`.
- **SSE без буферизации**: Nginx `proxy_buffering off;` + заголовок `X-Accel-Buffering: no` (включено).
- **Mute микрофона** (`anamClient.muteInputAudio()`) — исключает VAD‑прерывания, когда ввод только текстовый.
- **Модель OpenAI**: для максимальной скорости используйте `gpt-4.1-mini`/`gpt-4o-mini` в `/api/generate-assistant-response-fast`.

## Полезные ссылки по Anam

- Quickstart, session‑token, SDK `streamToVideoElement` — см. оф. доки.  
- TalkMessageStream для стриминга частей сообщения — см. оф. доки.
- События (speech start/stop, transcription) — см. оф. доки.

## Production
- Поставьте фронтенд за CDN, бэкенд — за Nginx (с `nginx.sse.conf`).
- В CORS/Referer задайте ваш домен `psychology-machines.ru`.
- Логику «прервать» (`interruptPersona`) вызывайте при новом вводе пользователя.

Удачи! 💙
