import { createClient, AnamClient } from '@anam-ai/js-sdk'
import { EVA_PERSONA_ID, LEO_PERSONA_ID, PABLO_PERSONA_ID } from './lib/constants'

/* ==============================
   Прокси Anam (как раньше) — НЕ трогаем стили
   ============================== */
const ANAM_BASE   = '/anam/api'
const ANAM_ORIGIN = 'https://api.anam.ai'

;(function patchFetchAndEventSourceForAnam() {
  const origFetch = window.fetch.bind(window)

  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else url = (input as Request).url

    if (url.startsWith(ANAM_ORIGIN)) {
      url = url.replace(ANAM_ORIGIN, ANAM_BASE)
      if (typeof input !== 'string' && !(input instanceof URL)) {
        const r = input as Request
        input = new Request(url, {
          method: r.method, headers: r.headers, body: r.body as any,
          mode: r.mode, credentials: r.credentials, cache: r.cache,
          redirect: r.redirect, referrer: r.referrer, referrerPolicy: r.referrerPolicy,
          integrity: r.integrity, keepalive: (r as any).keepalive, signal: r.signal,
        })
      } else {
        input = url
      }
    }
    return origFetch(input as any, init)
  }

  const OrigES = window.EventSource
  class PatchedES extends OrigES {
    constructor(url: string | URL, opts?: EventSourceInit) {
      const u = typeof url === 'string' ? url : url.href
      super(u.startsWith(ANAM_ORIGIN) ? u.replace(ANAM_ORIGIN, ANAM_BASE) : u, opts)
    }
  }
  ;(window as any).EventSource = PatchedES
})()

/* ==============================
   DOM
   ============================== */
const el = {
  sidebar: document.getElementById('sidebar') as HTMLElement | null,
  persona: document.getElementById('personaSelect') as HTMLSelectElement,
  video: document.getElementById('avatarVideo') as HTMLVideoElement,
  videoWrap: document.getElementById('videoContainer') as HTMLElement,
  spinner: document.getElementById('loading-spinner') as HTMLElement,
  chatMsg: document.getElementById('chatMsg') as HTMLElement,
  listenBtn: document.getElementById('listenButton') as HTMLButtonElement,
  exportBtn: document.getElementById('exportButton') as HTMLButtonElement,
  chatList: document.getElementById('chatList') as HTMLElement,
  chatName: document.getElementById('chatNameInput') as HTMLInputElement,
  chatCreate: document.getElementById('createChatButton') as HTMLButtonElement,
  chatHistory: document.getElementById('chatHistory') as HTMLElement,
}

/* ==============================
   Состояние
   ============================== */
let anamClient: AnamClient | null = null
let selectedPersona = ''       // выбранная модель
let currentChat: string | null = null
let isRecording = false
let userTranscript = ''
let currentUserBubble: HTMLDivElement | null = null
let activeES: EventSource | null = null

/* ==============================
   ThreadID per chat
   ============================== */
function getThreadKey(chat: string) { return `thread:${chat}` }
function getThreadIdFor(chat: string | null) {
  return chat ? (localStorage.getItem(getThreadKey(chat)) || null) : null
}
function setThreadIdFor(chat: string | null, id: string) {
  if (!chat || !id) return
  localStorage.setItem(getThreadKey(chat), id)
}

/* Предсоздание thread для ускорения первого ответа */
async function ensureThreadForCurrentChat() {
  if (!currentChat || !selectedPersona) return getThreadIdFor(currentChat)
  const existing = getThreadIdFor(currentChat)
  if (existing) return existing
  const res = await fetch(`/api/thread/new?model=${encodeURIComponent(selectedPersona)}`, { method: 'POST' })
  if (!res.ok) return null
  const j = await res.json().catch(() => ({}))
  if (j?.thread_id) {
    setThreadIdFor(currentChat, j.thread_id)
    return j.thread_id
  }
  return null
}

/* ==============================
   Хелперы
   ============================== */
type AnamSessionTokenResponse = { sessionToken: string; expiresAt?: string }

async function fetchAnamSessionToken(personaId: string): Promise<string> {
  const controller = new AbortController()
  const to = setTimeout(() => controller.abort(), 15000)
  const res = await fetch(`/anam/api/v1/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ personaConfig: { personaId, disableBrains: true } }),
  }).catch((e) => { throw new Error(`ANAM token fetch failed: ${e}`) })
  clearTimeout(to)
  if (!res.ok) throw new Error(`ANAM token error: ${res.status} ${await res.text().catch(()=> '')}`)
  const data = (await res.json()) as AnamSessionTokenResponse
  if (!data?.sessionToken) throw new Error('ANAM token error: empty payload')
  return data.sessionToken
}

function personaIdFromModel(model: string) {
  if (model === 'NICK_MODEL') return LEO_PERSONA_ID
  if (model === 'JOHN_PULSE_MODEL') return PABLO_PERSONA_ID
  return EVA_PERSONA_ID
}

function appendBubble(role: 'user'|'assistant', text: string, streaming = false) {
  const wrap = document.createElement('div')
  wrap.className = `message ${role === 'user' ? 'outgoing' : 'incoming'}`
  const bubble = document.createElement('div')
  bubble.className = `message-bubble ${role === 'user' ? 'outgoing' : 'incoming'}`
  bubble.textContent = text
  if (streaming) bubble.setAttribute('data-streaming', 'true')
  wrap.appendChild(bubble)
  el.chatHistory.appendChild(wrap)
  el.chatHistory.scrollTop = el.chatHistory.scrollHeight
  return bubble
}

function requireChatOrWarn(): boolean {
  if (!currentChat) {
    alert('Сначала выберите или создайте чат слева.')
    return false
  }
  return true
}

/* ==============================
   Сессия ANAM (запуск при выбранном чате)
   ============================== */
async function initializeAvatarSession() {
  if (!selectedPersona || !currentChat) return
  if (anamClient) return

  // UI
  el.videoWrap.style.display = 'flex'
  el.videoWrap.classList.add('loading')
  el.spinner.style.display = 'block'
  el.chatMsg.style.display = 'none'
  el.listenBtn.style.display = 'flex'
  el.chatHistory.style.display = 'block'

  const personaId = personaIdFromModel(selectedPersona)
  const token = await fetchAnamSessionToken(personaId)

  anamClient = (createClient as any)(token, {
    baseUrl: ANAM_BASE,
    apiBaseUrl: ANAM_BASE,
  })

  // <video>
  el.video.playsInline = true
  el.video.autoplay = true
  el.video.muted = false

  anamClient?.streamToVideoElement('avatarVideo')
  anamClient?.muteInputAudio()

  anamClient?.addListener('VIDEO_PLAY_STARTED' as any, () => {
    el.spinner.style.display = 'none'
    el.videoWrap.classList.remove('loading')
  })

  // Пока говорим — наращиваем пользовательский пузырь (реал-тайм)
  anamClient?.addListener('MESSAGE_HISTORY_UPDATED' as any, (messages: any[]) => {
    if (!isRecording || !currentUserBubble) return
    const last = messages[messages.length - 1]
    if (last?.role === 'user' && last?.content) {
      userTranscript += (userTranscript ? ' ' : '') + last.content
      currentUserBubble.textContent = userTranscript
      el.chatHistory.scrollTop = el.chatHistory.scrollHeight
    }
  })
}

async function terminateAvatarSession() {
  try { activeES?.close() } catch {}
  activeES = null
  try { await anamClient?.stopStreaming?.() } catch {}
  anamClient = null
  isRecording = false
  el.listenBtn.classList.remove('active')
  el.listenBtn.style.display = 'none'
  el.spinner.style.display = 'none'
  el.videoWrap.classList.remove('loading')
}

/* ==============================
   Голос
   ============================== */
async function startRecording() {
  if (!requireChatOrWarn()) return
  if (!anamClient) await initializeAvatarSession()

  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext
    if (AC) { const ac = new AC(); if (ac.state === 'suspended') await ac.resume() }
  } catch {}

  anamClient?.unmuteInputAudio()
  isRecording = true
  userTranscript = ''
  currentUserBubble = appendBubble('user', '', true)
  el.listenBtn.classList.add('active')
}

async function stopRecording() {
  anamClient?.muteInputAudio()
  isRecording = false
  el.listenBtn.classList.remove('active')

  if (currentUserBubble && userTranscript.trim()) {
    currentUserBubble.removeAttribute('data-streaming')
    currentUserBubble.textContent = userTranscript.trim()
    await handleUserTranscript(userTranscript.trim())
  }
  currentUserBubble = null
}

async function toggleRecording() {
  if (!requireChatOrWarn()) return
  if (isRecording) await stopRecording()
  else await startRecording()
}

/* ==============================
   Генерация ответа (SSE) + озвучка + THREAD_ID
   ============================== */
async function handleUserTranscript(transcript: string) {
  if (!transcript) return
  if (!anamClient) await initializeAvatarSession()
  if (!anamClient) return

  // подстрахуем и предсоздадим тред (если ещё нет)
  await ensureThreadForCurrentChat().catch(() => null)

  const bubble = appendBubble('assistant', '', true)
  const talk = anamClient.createTalkMessageStream?.()
  let buffer = ''
  let rafLock = false

  const existingThreadId = getThreadIdFor(currentChat)
  const params = new URLSearchParams({
    prompt: transcript,
    model: selectedPersona,
    ...(existingThreadId ? { thread_id: existingThreadId } : {}),
    t: String(Date.now()),
  })

  const es = new EventSource(`/api/generate-assistant-response?${params.toString()}`)
  activeES = es

  el.video.muted = false

  es.onmessage = async (ev) => {
    const chunk = ev.data as string

    // Ловим первый служебный чанк с thread_id
    if (chunk.startsWith('__THREAD_ID__:')) {
      const id = chunk.slice('__THREAD_ID__:'.length).trim()
      if (id) setThreadIdFor(currentChat, id)
      return
    }

    if (chunk === '__END_OF_STREAM__') {
      es.close()
      if (activeES === es) activeES = null
      if (talk?.isActive()) await talk.endMessage()
      bubble.removeAttribute('data-streaming')
      bubble.textContent = buffer.trim()
      return
    }

    // Стримим ассистента в озвучку и в чат
    if (talk?.isActive()) talk.streamMessageChunk(chunk, false)
    buffer += chunk
    if (!rafLock) {
      rafLock = true
      requestAnimationFrame(() => {
        bubble.textContent = buffer
        el.chatHistory.scrollTop = el.chatHistory.scrollHeight
        rafLock = false
      })
    }
  }

  es.onerror = () => {
    try { es.close() } catch {}
    if (activeES === es) activeES = null
    if (talk?.isActive()) talk.endMessage()
    bubble.removeAttribute('data-streaming')
    if (!buffer) bubble.textContent = 'Ошибка соединения с моделью. Попробуйте ещё раз.'
  }
}

/* ==============================
   Чаты
   ============================== */
function loadChats() {
  el.chatList.innerHTML = ''
  const names: string[] = JSON.parse(localStorage.getItem('chatNames') || '[]')
  names.forEach(addChatItem)
}

function addChatItem(name: string) {
  const li = document.createElement('li')
  li.addEventListener('click', () => selectChat(name))

  const span = document.createElement('span'); span.textContent = name

  const box = document.createElement('div'); box.className = 'dropdown-container'
  const dots = document.createElement('button'); dots.className = 'dots-button'; dots.textContent = '⋮'
  const menu = document.createElement('div'); menu.className = 'dropdown-menu'

  const rename = document.createElement('button'); rename.textContent = 'Rename'
  rename.addEventListener('click', (e) => {
    e.stopPropagation()
    const nn = prompt('New name for chat', name) || name
    if (nn && nn !== name) {
      const data = localStorage.getItem(name)
      if (data) { localStorage.setItem(nn, data); localStorage.removeItem(name) }
      const list: string[] = JSON.parse(localStorage.getItem('chatNames') || '[]')
      localStorage.setItem('chatNames', JSON.stringify(list.map(n => n === name ? nn : n)))
      span.textContent = nn
      if (currentChat === name) currentChat = nn
    }
    menu.classList.remove('active')
  })

  const del = document.createElement('button'); del.textContent = 'Delete'
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    li.remove()
    localStorage.removeItem(name)
    const list: string[] = JSON.parse(localStorage.getItem('chatNames') || '[]')
    localStorage.setItem('chatNames', JSON.stringify(list.filter(n => n !== name)))
    if (currentChat === name) {
      // чистим связанный thread_id
      localStorage.removeItem(getThreadKey(name))
      currentChat = null
      el.chatHistory.style.display = 'none'
      el.chatHistory.innerHTML = ''
      el.chatMsg.style.display = ''
      terminateAvatarSession()
    }
  })

  dots.addEventListener('click', (e) => {
    e.stopPropagation()
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'))
    menu.classList.toggle('active')
  })

  menu.appendChild(rename); menu.appendChild(del)
  box.appendChild(dots); box.appendChild(menu)
  li.appendChild(span); li.appendChild(box)
  el.chatList.appendChild(li)
}

/* ← ВОТ ЕЁ И НЕ ХВАТАЛО */
function createChat() {
  if (!selectedPersona) { alert('Сначала выберите персону.'); return }
  const name = (el.chatName.value || '').trim()
  if (!name) return
  const chats = new Set<string>(JSON.parse(localStorage.getItem('chatNames') || '[]'))
  chats.add(name)
  localStorage.setItem('chatNames', JSON.stringify(Array.from(chats)))
  localStorage.setItem(name, JSON.stringify({ messages: [] }))
  // очищаем старый thread_id если вдруг совпало имя
  localStorage.removeItem(getThreadKey(name))
  el.chatName.value = ''
  addChatItem(name)
  selectChat(name)
}

async function selectChat(name: string) {
  currentChat = name
  localStorage.setItem('currentChat', name)

  el.chatHistory.innerHTML = ''
  const data = JSON.parse(localStorage.getItem(name) || '{"messages":[]}')
  for (const m of (data.messages || [])) appendBubble(m.role, m.content, false)

  // заранее создаём thread (ускоряет первый ответ)
  await ensureThreadForCurrentChat().catch(() => null)

  initializeAvatarSession().catch(console.error)
}

/* ==============================
   Wire UI
   ============================== */
el.persona.addEventListener('change', async () => {
  // только запоминаем выбор, НЕ запускаем сессию
  selectedPersona = el.persona.value

  // если была сессия — закрыть
  if (anamClient) await terminateAvatarSession()

  // UI: вернуться к подсказке «выберите чат»
  el.spinner.style.display = 'none'
  el.videoWrap.classList.remove('loading')
  el.listenBtn.style.display = 'none'
  el.chatMsg.style.display = ''
  el.chatHistory.style.display = 'none'
})

el.chatCreate.addEventListener('click', createChat)
el.listenBtn.addEventListener('click', async () => { await toggleRecording() })

el.exportBtn.addEventListener('click', () => {
  const name = localStorage.getItem('currentChat')
  if (!name) return alert('Select a chat first.')
  const data = localStorage.getItem(name) || '{"messages":[]}'
  const blob = new Blob([data], { type: 'application/json;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}.json`
  a.click()
  URL.revokeObjectURL(a.href)
})

window.addEventListener('load', async () => {
  el.video.setAttribute('playsinline', '')
  el.video.setAttribute('autoplay', '')
  el.video.muted = false

  loadChats()

  const saved = localStorage.getItem('currentChat')
  if (saved) await selectChat(saved)
})
