# Аватар-психолог (Anam.ai + FastAPI + OpenAI) — низкая задержка

Готовый стек для стримингового аватара-психолога на сайте.

- Видео/аудио — **Anam.ai WebRTC SDK**
- Текст — **OpenAI Assistants API** (с `file_search` присутствует; thread_id переиспользуем)
- Озвучивание ответа по мере генерации — **TalkMessageStream** (фронт льёт токены в аватар)
- Прокси и SSE — **FastAPI** + **Nginx** (буферизация выключена)

---

## Архитектура латентности

1. Браузер устанавливает **WebRTC** с Anam → видео аватара сразу в `<video>`.
2. Anam используется без встроенного LLM (наш текстовый стрим быстрее).
3. Бэкенд стримит токены из **OpenAI** (SSE) → фронт **сразу** шлёт их в `talkMessageStream`.
4. **Nginx** настроен с `proxy_buffering off` и `X-Accel-Buffering: no` для мгновенной доставки чанков.

---

## Требования (сервер Rhythmic / Ubuntu)

- **Python 3.12** (проект тестировался на 3.12)
- **Node через Snap** (LTS)
- **Nginx**
- Порт 80/443 открыт (UFW/SG)
- Домен `psychology-machines.ru` указывает на сервер (A-запись)

---

## 1) Подготовка сервера (разово)

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install git nginx python3.12 python3.12-venv python3.12-distutils software-properties-common || true
# если 3.12 нет в стандартных репах:
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt update
sudo apt -y install python3.12 python3.12-venv
```

Node через Snap (LTS):

```bash
sudo snap install node --classic --channel=20/stable   # можно 22/stable
/snap/bin/node -v
/snap/bin/npm -v
```

Nginx + firewall:
```bash
sudo ufw allow 'Nginx Full' || true
sudo systemctl enable nginx
sudo systemctl start nginx
```

Каталог проекта:
```bash
sudo mkdir -p /opt/anam-ai-avatars
sudo chown -R $USER:$USER /opt/anam-ai-avatars
```

## 2) Клонирование и окружение
```bash
cd backend
python3.12 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
```
backend/.env (минимум):
```
OPENAI_API_KEY=sk-********************************
ANAM_API_KEY=anam_********************************
ANAM_BASE=https://api.anam.ai
```

CORS/Referer в коде бэка ожидают https://psychology-machines.ru и http://localhost:5173. Если домен другой — поменяйте.

## 3) Systemd-сервис для FastAPI
Можно поднять через tmux

## 4) Сборка фронтенда
```bash
cd /opt/anam-ai-avatars/frontend
/snap/bin/npm ci || /snap/bin/npm install
/snap/bin/npm run build
```

Выкатить статику:
```bash
sudo mkdir -p /var/www/psychology-machines.ru
sudo rsync -a --delete dist/ /var/www/psychology-machines.ru/
```

## 5) Nginx (SSE + прокси Anam + SPA)
/etc/nginx/sites-available/psychology-machines.ru:

```nginx
server {
  listen 80;
  server_name psychology-machines.ru;

  # фронтенд
  root /var/www/psychology-machines.ru;
  index index.html;

  # OpenAI SSE
  location /api/ {
    proxy_pass         http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;

    # критично для SSE:
    proxy_buffering off;
    gzip off;
    add_header X-Accel-Buffering no;
  }

  # Прокси → бэкенд → Anam (key скрыт в бэке)
  location /anam/api/ {
    proxy_pass         http://127.0.0.1:8000/anam/api/;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_read_timeout 600s;

    proxy_buffering off;
    add_header X-Accel-Buffering no;
  }

  # SPA fallback
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

Подключить сайт:
```bash
sudo ln -s /etc/nginx/sites-available/psychology-machines.ru /etc/nginx/sites-enabled/psychology-machines.ru
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS (Certbot)
```bash
sudo snap install core; sudo snap refresh core
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
```

# ВНИМАНИЕ: добавляйте www ТОЛЬКО если есть A-запись на www
sudo certbot --nginx -d psychology-machines.ru --agree-tos -m you@example.com --redirect
# или
# sudo certbot --nginx -d psychology-machines.ru -d www.psychology-machines.ru --agree-tos -m you@example.com --redirect
Если www не прописан в DNS — не добавляйте его, иначе будет NXDOMAIN.

## 6) Обновление проекта в проде (команды по шагам)
Фронтенд:

```bash
cd frontend
npm ci
npm run build
sudo rsync -a --delete dist/ /var/www/psychology-machines.ru/
sudo systemctl reload nginx
```

Бэкенд:

```bash
tmux attach -t backend (если создана сессия backend)
```
uvicorn должен обновиться автоматически
