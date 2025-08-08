import { createClient, AnamClient } from '@anam-ai/js-sdk';
import { AnamEvent } from '@anam-ai/js-sdk/dist/module/types';
import { EVA_PERSONA_ID, LEO_PERSONA_ID, PABLO_PERSONA_ID } from './lib/constants';

/* ==============================
   Маршруты
   ============================== */
const ANAM_BASE        = '/anam/api';
const ANAM_ORIGIN      = 'https://api.anam.ai';

/* ==============================
   Патчируем fetch/EventSource для ANAM:
   всё, что шлёт SDK на https://api.anam.ai → /anam/api
   ============================== */
(function patchFetchAndEventSourceForAnam() {
  const origFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = (input as Request).url;
    }

    if (url.startsWith(ANAM_ORIGIN)) {
      url = url.replace(ANAM_ORIGIN, ANAM_BASE);

      if (typeof input !== 'string' && !(input instanceof URL)) {
        const r = input as Request;
        input = new Request(url, {
          method: r.method,
          headers: r.headers,
          body: r.body as any,
          mode: r.mode,
          credentials: r.credentials,
          cache: r.cache,
          redirect: r.redirect,
          referrer: r.referrer,
          referrerPolicy: r.referrerPolicy,
          integrity: r.integrity,
          keepalive: (r as any).keepalive,
          signal: r.signal,
        });
      } else {
        input = url;
      }
    }

    return origFetch(input as any, init);
  };

  const OrigES = window.EventSource;
  class PatchedEventSource extends OrigES {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      const u = typeof url === 'string' ? url : url.href;
      const patched = u.startsWith(ANAM_ORIGIN) ? u.replace(ANAM_ORIGIN, ANAM_BASE) : u;
      super(patched, eventSourceInitDict);
    }
  }
  (window as any).EventSource = PatchedEventSource;
})();

/* ==============================
   DOM
   ============================== */
const elements = {
  video: document.getElementById('avatarVideo') as HTMLVideoElement,
  listenButton: document.getElementById('listenButton') as HTMLButtonElement,
  chatHistory: document.getElementById('chatHistory') as HTMLElement,
  chatList: document.getElementById('chatList') as HTMLElement,
  chatNameInput: document.getElementById('chatNameInput') as HTMLInputElement,
  createChatButton: document.getElementById('createChatButton') as HTMLButtonElement,
  videoContainer: document.querySelector('.video-container') as HTMLElement,
  spinnerLoaderVideo: document.getElementById('loading-spinner') as HTMLElement,
  exportBtn: document.getElementById('exportButton') as HTMLElement,
  personaSelect: document.getElementById('personaSelect') as HTMLSelectElement,
};

/* ==============================
   Состояние
   ============================== */
let anamClient: AnamClient | null = null;
let selectedPersona = '';
let isRecording = false;
let currentUserMessageElement: HTMLDivElement | null = null;
let userTranscript = '';
let sessionTimeout: number | null = null;
let activeEventSource: EventSource | null = null;

/* ==============================
   Вспомогалки
   ============================== */
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function startSessionTimeout() {
  if (sessionTimeout) clearTimeout(sessionTimeout);
  sessionTimeout = window.setTimeout(() => {
    terminateAvatarSession();
    alert('Сессия завершена из-за истечения времени.');
  }, 5 * 60 * 1000);
}

function setupListenButton() {
  elements.listenButton.style.display = 'flex';
  elements.listenButton.removeEventListener('click', toggleRecording);
  elements.listenButton.addEventListener('click', toggleRecording);
  elements.exportBtn.style.display = 'flex';
}

/* ==============================
   Микрофон (iOS/Firefox-safe)
   ============================== */
async function startRecording() {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      const ac = new AC();
      if (ac.state === 'suspended') await ac.resume();
    }
  } catch {}

  anamClient?.unmuteInputAudio();
  isRecording = true;

  currentUserMessageElement = appendMessageBubble('user', '', true);
  userTranscript = '';
  elements.listenButton.classList.add('active');
}

async function stopRecording() {
  anamClient?.muteInputAudio();
  isRecording = false;
  elements.listenButton.classList.remove('active');

  if (currentUserMessageElement && userTranscript.trim()) {
    currentUserMessageElement.removeAttribute('data-streaming');
    currentUserMessageElement.textContent = userTranscript.trim();
    await handleUserTranscript(userTranscript.trim());
  }
  currentUserMessageElement = null;
}

async function toggleRecording() {
  if (isRecording) await stopRecording();
  else await startRecording();
}

type AnamSessionTokenResponse = {
  sessionToken: string;
  expiresAt?: string;
};

// Получаем sessionToken у нашего бэкенда-прокси (ключ ANAM_API_KEY не светим в браузере)
async function fetchAnamSessionToken(personaId: string): Promise<string> {
  // на клиенте никаких Authorization-заголовков! Бэкенд сам подставляет ANAM_API_KEY
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s таймаут

  const res = await fetch(`${ANAM_BASE}/v1/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      personaConfig: {
        personaId,
        disableBrains: true, // как и раньше — чистый стрим без их «мозгов»
      },
    }),
  }).catch((e) => {
    throw new Error(`ANAM token fetch failed: ${e}`);
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ANAM token error: ${res.status} ${text}`);
  }

  const data = (await res.json()) as AnamSessionTokenResponse;
  if (!data?.sessionToken) {
    throw new Error('ANAM token error: empty payload');
  }
  return data.sessionToken;
}

/* ==============================
   Сессия ANAM
   ============================== */
async function initializeAvatarSession() {
  elements.videoContainer.style.display = 'flex';

  let personaId = EVA_PERSONA_ID;
  if (selectedPersona === 'NICK_MODEL') personaId = LEO_PERSONA_ID;
  else if (selectedPersona === 'JOHN_PULSE_MODEL') personaId = PABLO_PERSONA_ID;

  const sessionToken = await fetchAnamSessionToken(personaId);

  anamClient = (createClient as any)(sessionToken, {
    baseUrl: ANAM_BASE,
    apiBaseUrl: ANAM_BASE,
  });

  // Настройки <video> для автоплей
  const v = elements.video;
  v.muted = false;
  v.playsInline = true;
  v.autoplay = true;

  anamClient?.streamToVideoElement('avatarVideo');
  anamClient?.muteInputAudio();

  startSessionTimeout();
  setupListenButton();

  anamClient?.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
    elements.spinnerLoaderVideo.style.display = 'none';
    elements.videoContainer.className = 'video-container';
  });

  anamClient?.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (messages: any[]) => {
    if (!isRecording || !currentUserMessageElement) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'user' && last?.content) {
      userTranscript += ' ' + last.content;
      currentUserMessageElement.textContent = userTranscript.trim();
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    }
  });
}

async function terminateAvatarSession() {
  try { activeEventSource?.close(); } catch {}
  activeEventSource = null;
  try { await anamClient?.stopStreaming?.(); } catch {}
  anamClient = null;
  elements.listenButton.style.display = 'none';
}

/* ==============================
   Рендер чата
   ============================== */
function appendMessageBubble(role: 'user'|'assistant', text: string, streaming = false) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role === 'user' ? 'outgoing' : 'incoming'}`;

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${role === 'user' ? 'outgoing' : 'incoming'}`;
  bubble.textContent = text;
  if (streaming) bubble.setAttribute('data-streaming', 'true');

  wrapper.appendChild(bubble);
  elements.chatHistory.appendChild(wrapper);
  elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
  return bubble;
}

/* ==============================
   Генерация ответа (SSE) + озвучка (ANAM)
   ============================== */
async function handleUserTranscript(transcript: string) {
  if (!transcript) return;

  const messageBubble = appendMessageBubble('assistant', '', true);
  let talkStream = anamClient?.createTalkMessageStream?.();

  const url = `/api/generate-assistant-response?prompt=${encodeURIComponent(transcript)}&model=${encodeURIComponent(selectedPersona)}&t=${Date.now()}`;
  const es = new EventSource(url);
  (window as any).__activeES = es;

  let accumulatedText = '';
  let scheduledUpdate = false;

  try {
    es.onmessage = async (ev) => {
      const chunk = ev.data;

      if (chunk === '__END_OF_STREAM__') {
        es.close();
        if ((window as any).__activeES === es) (window as any).__activeES = null;
        if (talkStream?.isActive()) await talkStream.endMessage();

        messageBubble.removeAttribute('data-streaming');
        messageBubble.textContent = accumulatedText.trim();
        return;
      }

      // отдаём куски в ANAM на озвучку
      if (talkStream?.isActive()) talkStream.streamMessageChunk(chunk, false);

      // и отображаем в чате
      accumulatedText += chunk;
      if (!scheduledUpdate) {
        scheduledUpdate = true;
        requestAnimationFrame(() => {
          messageBubble.textContent = accumulatedText;
          elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
          scheduledUpdate = false;
        });
      }
    };

    es.onerror = (err) => {
      console.error('SSE Error:', err);
      try { es.close(); } catch {}
      if ((window as any).__activeES === es) (window as any).__activeES = null;
      if (talkStream?.isActive()) talkStream.endMessage();
      messageBubble.textContent = 'Ошибка соединения с моделью. Попробуйте ещё раз.';
    };
  } catch (error) {
    console.error('Error handling transcript:', error);
    if (talkStream?.isActive()) talkStream.endMessage();
    messageBubble.textContent = 'Произошла ошибка. Попробуйте ещё раз.';
  }
}

/* ==============================
   Список чатов + экспорт (как у тебя)
   ============================== */
function loadChatListFromStorage() {
  elements.chatList.innerHTML = '';
  const chatNames = JSON.parse(localStorage.getItem('chatNames') || '[]');
  chatNames.forEach((name: string) => appendChatItem(name));
}

function appendChatItem(name: string) {
  const li = document.createElement('li');
  li.addEventListener('click', () => selectChat(name));

  const span = document.createElement('span');
  span.textContent = name;

  const box = document.createElement('div');
  box.className = 'dropdown-container';

  const dots = document.createElement('button');
  dots.className = 'dots-button';
  dots.textContent = '⋮';

  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';

  const rename = document.createElement('button');
  rename.textContent = 'Rename';
  rename.addEventListener('click', (e) => {
    e.stopPropagation();
    const nn = prompt('New name for chat', name) || name;
    if (nn && nn !== name) {
      const data = localStorage.getItem(name);
      if (data) {
        localStorage.setItem(nn, data);
        localStorage.removeItem(name);
      }
      const list = JSON.parse(localStorage.getItem('chatNames') || '[]');
      const updated = list.map((n: string) => (n === name ? nn : n));
      localStorage.setItem('chatNames', JSON.stringify(updated));
      span.textContent = nn;
    }
    menu.classList.remove('active');
  });

  const del = document.createElement('button');
  del.textContent = 'Delete';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    li.remove();
    localStorage.removeItem(name);
    const list = JSON.parse(localStorage.getItem('chatNames') || '[]');
    localStorage.setItem('chatNames', JSON.stringify(list.filter((n: string) => n !== name)));
  });

  dots.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
    menu.classList.toggle('active');
  });

  menu.appendChild(rename);
  menu.appendChild(del);
  box.appendChild(dots);
  box.appendChild(menu);
  li.appendChild(span);
  li.appendChild(box);

  elements.chatList.appendChild(li);
}

function selectChat(name: string) {
  localStorage.setItem('currentChat', name);
  const data = JSON.parse(localStorage.getItem(name) || '{"messages": []}');
  elements.chatHistory.innerHTML = '';
  for (const m of data.messages || []) {
    appendMessageBubble(m.role, m.content, false);
  }
}

function createChat() {
  if (!selectedPersona) { alert('Choose your persona first'); return; }
  const name = (elements.chatNameInput.value || '').trim();
  if (!name) return;

  const chats = new Set(JSON.parse(localStorage.getItem('chatNames') || '[]'));
  chats.add(name);
  localStorage.setItem('chatNames', JSON.stringify(Array.from(chats)));
  localStorage.setItem(name, JSON.stringify({ messages: [] }));
  elements.chatNameInput.value = '';
  appendChatItem(name);
}

function exportCurrentChat() {
  const currentChatName = localStorage.getItem('currentChat');
  if (!currentChatName) {
    alert('Please select a chat from the left or create a new one.');
    return;
  }

  const chatData = localStorage.getItem(currentChatName);
  if (!chatData) {
    alert('History of selected chat is empty!');
    return;
  }

  const jsonString = JSON.stringify(JSON.parse(chatData), null, 2);
  const utf8Blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });

  const downloadUrl = URL.createObjectURL(utf8Blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `${currentChatName}.json`;
  a.click();
  URL.revokeObjectURL(downloadUrl);
}

/* ==============================
   Wire UI
   ============================== */
elements.personaSelect.addEventListener('change', async () => {
  selectedPersona = elements.personaSelect.value;
  await initializeAvatarSession();
});

document.getElementById('burgerMenu')?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('sidebar')?.classList.toggle('visible');
});

elements.createChatButton.addEventListener('click', createChat);
elements.exportBtn.addEventListener('click', exportCurrentChat);

window.addEventListener('load', () => {
  loadChatListFromStorage();
  // iOS-friendly флаги
  elements.video.setAttribute('playsinline', '');
  elements.video.setAttribute('autoplay', '');
  elements.video.muted = false; // как в твоей версии
});
