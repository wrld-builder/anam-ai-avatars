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
    let url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

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

let anamClient: AnamClient | null = null;
let isRecording = false;
let userTranscript = '';
let currentChatName: string | null = null;
let currentUserMessageElement: HTMLElement | null = null;
let selectedPersona: string | null = null;
let sessionTimeout: number | null = null;

// Активный SSE к твоему бэкенду — чтобы не висло «вечно»
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
  elements.listenButton.classList.add('active');
  userTranscript = '';
  currentUserMessageElement = null;
}

async function stopRecording() {
  anamClient?.muteInputAudio();
  isRecording = false;
  elements.listenButton.classList.remove('active');

  if (userTranscript.trim()) {
    await handleUserTranscript(userTranscript.trim());
  }
  currentUserMessageElement = null;
}

async function toggleRecording() {
  if (isRecording) await stopRecording();
  else await startRecording();
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

  (anamClient as any).addListener?.('error', (e: any) => console.error('ANAM error', e));

  anamClient?.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, async (messages: any[]) => {
    if (!messages.length) return;
    const last = messages[messages.length - 1];

    if (last.role === 'user' && isRecording) {
      userTranscript += `${last.content} `;

      if (!currentUserMessageElement) {
        currentUserMessageElement = document.createElement('div');
        currentUserMessageElement.className = 'message outgoing';
        currentUserMessageElement.innerHTML = `
          <div class="message-bubble outgoing">${escapeHtml(last.content)}</div>`;
        elements.chatHistory.appendChild(currentUserMessageElement);
      } else {
        currentUserMessageElement.innerHTML = `
          <div class="message-bubble outgoing">${escapeHtml(userTranscript)}</div>`;
      }
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
    }

    if (last.role === 'assistant') {
      let incoming = elements.chatHistory.querySelector('.message.incoming:last-of-type') as HTMLElement | null;
      if (!incoming) {
        incoming = document.createElement('div');
        incoming.className = 'message incoming';
        incoming.innerHTML = `<div class="message-bubble incoming"></div>`;
        elements.chatHistory.appendChild(incoming);
      }
      const bubble = incoming.firstElementChild as HTMLElement;
      bubble.textContent = last.content || '';
      elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;

      if (currentChatName) {
        const chatData = getChatData(currentChatName);
        chatData.messages.push({ sender: 'Bot', message: last.content || '' });
        saveChatData(currentChatName, chatData);
      }
    }
  });
}

/* ==============================
   Отправка текста пользователя
   ============================== */
async function handleUserTranscript(transcript: string) {
  // История
  if (currentChatName) {
    const chatData = getChatData(currentChatName);
    chatData.messages.push({ sender: 'User', message: transcript });
    saveChatData(currentChatName, chatData);
  }

  // Пузырь для ответа
  const botMessageElement = document.createElement('div');
  botMessageElement.className = 'message incoming';
  botMessageElement.innerHTML = `<div class="message-bubble incoming">…</div>`;
  elements.chatHistory.appendChild(botMessageElement);
  const messageBubble = botMessageElement.firstElementChild as HTMLElement;

  // Закрыть предыдущий SSE, если был
  if ((window as any).__activeES) {
    try { (window as any).__activeES.close(); } catch {}
    (window as any).__activeES = null;
  }

  // Создаём talkStream (чтобы ANAM озвучивал текст, который пришёл от твоей модели)
  const talkStream = anamClient?.createTalkMessageStream();

  try {
    const url =
      `/api/generate-assistant-response?prompt=${encodeURIComponent(transcript)}&model=${encodeURIComponent(String(selectedPersona || 'EVA'))}&t=${Date.now()}`;

    const es = new EventSource(url);
    (window as any).__activeES = es;

    let accumulatedText = '';
    let scheduledUpdate = false;

    es.onmessage = async (event) => {
      const chunk = event.data;

      if (chunk === '__END_OF_STREAM__') {
        es.close();
        if ((window as any).__activeES === es) (window as any).__activeES = null;
        if (talkStream?.isActive()) await talkStream.endMessage();

        if (currentChatName) {
          const chatData = getChatData(currentChatName);
          chatData.messages.push({ sender: 'Bot', message: accumulatedText });
          saveChatData(currentChatName, chatData);
        }
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
   Завершение сессии
   ============================== */
async function terminateAvatarSession() {
  if (activeEventSource) {
    try { activeEventSource.close(); } catch {}
    activeEventSource = null;
  }
  if (anamClient) anamClient.stopStreaming();
  anamClient = null;

  elements.videoContainer.style.display = 'none';
  elements.listenButton.style.display = 'none';
  elements.chatHistory.style.display = 'none';

  if (sessionTimeout) {
    clearTimeout(sessionTimeout);
    sessionTimeout = null;
  }
}

/* ==============================
   Storage
   ============================== */
function saveChatData(chatName: string, chatData: { messages: { sender: string; message: string }[] }) {
  localStorage.setItem(chatName, JSON.stringify(chatData));
}

function getChatData(chatName: string): { messages: { sender: string; message: string }[] } {
  return JSON.parse(localStorage.getItem(chatName) || '{"messages":[]}');
}

function loadChatHistory(chatName: string) {
  elements.chatHistory.innerHTML = '';
  const chatData = getChatData(chatName);
  chatData.messages.forEach(({ sender, message }) => {
    const p = document.createElement('p');
    if (sender === 'User') {
      p.innerHTML = `
        <div class="message outgoing">
          <div class="message-bubble outgoing">${escapeHtml(message)}</div>
        </div>`;
    } else {
      p.innerHTML = `
        <div class="message incoming">
          <div class="message-bubble incoming">${escapeHtml(message)}</div>
        </div>`;
    }
    elements.chatHistory.appendChild(p);
  });
  elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
  elements.chatHistory.style.display = 'block';
}

/* ==============================
   ANAM: токен через прокси
   ============================== */
async function fetchAnamSessionToken(personaId: string): Promise<string> {
  const res = await fetch(`${ANAM_BASE}/v1/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaConfig: { personaId, disableBrains: true } }),
  });
  if (!res.ok) throw new Error('ANAM token error: ' + res.status + ' ' + (await res.text()));
  const j = await res.json();
  return j.sessionToken;
}

/* ==============================
   UI
   ============================== */
function addChatToList(chatName: string) {
  const chatItem = document.createElement('li');
  chatItem.addEventListener('click', () => loadChat(chatName));

  const chatNameContainer = document.createElement('span');
  chatNameContainer.textContent = chatName;

  const dropdownContainer = document.createElement('div');
  dropdownContainer.className = 'dropdown-container';

  const dotsButton = document.createElement('button');
  dotsButton.className = 'dots-button';
  dotsButton.textContent = '⋮';

  const dropdownMenu = document.createElement('div');
  dropdownMenu.className = 'dropdown-menu';

  const deleteButton = document.createElement('button');
  deleteButton.className = 'delete-button';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    chatItem.remove();
    localStorage.removeItem(chatName);
    const savedChats = JSON.parse(localStorage.getItem('chatNames') || '[]');
    const updated = savedChats.filter((name: string) => name !== chatName);
    localStorage.setItem('chatNames', JSON.stringify(updated));
  });

  dotsButton.addEventListener('click', (event) => {
    event.stopPropagation();
    dropdownMenu.classList.toggle('active');
  });
  document.addEventListener('click', () => dropdownMenu.classList.remove('active'));

  dropdownMenu.appendChild(deleteButton);
  dropdownContainer.appendChild(dotsButton);
  dropdownContainer.appendChild(dropdownMenu);
  chatItem.appendChild(chatNameContainer);
  chatItem.appendChild(dropdownContainer);
  elements.chatList.appendChild(chatItem);
}

async function loadChat(chatName: string) {
  if (!selectedPersona) {
    alert('Choose person, you want to talk with!');
    return;
  }
  if (anamClient) await terminateAvatarSession();

  currentChatName = chatName;
  loadChatHistory(chatName);
  await initializeAvatarSession();
}

elements.createChatButton.addEventListener('click', () => {
  if (!selectedPersona) {
    alert('Choose person, you want to talk with!');
    return;
  }
  const chatName = elements.chatNameInput.value.trim();
  if (!chatName) return;

  addChatToList(chatName);
  saveChatData(chatName, { messages: [] });
  elements.chatNameInput.value = '';

  const savedChats = JSON.parse(localStorage.getItem('chatNames') || '[]');
  if (!savedChats.includes(chatName)) {
    savedChats.push(chatName);
    localStorage.setItem('chatNames', JSON.stringify(savedChats));
  }
  loadChat(chatName);
});

elements.exportBtn.addEventListener('click', () => {
  if (!currentChatName) {
    alert('Chat not selected! Please, select chat for export.');
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
  a.download = `${currentChatName}_history.json`;
  a.click();
  URL.revokeObjectURL(downloadUrl);
});

elements.personaSelect.addEventListener('change', () => {
  selectedPersona = elements.personaSelect.value;
});

window.addEventListener('load', () => {
  if (elements.video) {
    elements.video.setAttribute('playsinline', '');
    elements.video.setAttribute('autoplay', '');
    elements.video.muted = true;
  }
  const savedChats = JSON.parse(localStorage.getItem('chatNames') || '[]');
  savedChats.forEach(addChatToList);
});
