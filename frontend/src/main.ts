// src/main.ts
import { createClient, AnamClient } from '@anam-ai/js-sdk'
import { EVA_PERSONA_ID, LEO_PERSONA_ID, PABLO_PERSONA_ID } from './lib/constants'

/* ==============================
   Константы
   ============================== */
// Бэкенд-прокси — только для получения sessionToken (прячет ANAM_API_KEY)
const ANAM_PROXY_BASE = '/anam/api'
// Весь SDK (REST + WS) идёт НАПРЯМУЮ в Anam — уже только sessionToken
const ANAM_DIRECT_BASE = 'https://api.anam.ai'

/* ==============================
   DOM
   ============================== */
const el = {
  burger: document.getElementById('burgerMenu') as HTMLElement | null,
  sidebar: document.getElementById('sidebar') as HTMLElement | null,

  persona: document.getElementById('personaSelect') as HTMLSelectElement | null,
  videoWrap: document.getElementById('videoContainer') as HTMLElement | null,
  spinner: document.getElementById('loading-spinner') as HTMLElement | null,
  video: document.getElementById('avatarVideo') as HTMLVideoElement | null,

  chatMsg: document.getElementById('chatMsg') as HTMLElement | null,
  mic: document.getElementById('listenButton') as HTMLButtonElement | null,
  exportBtn: document.getElementById('exportButton') as HTMLButtonElement | null,

  chatList: document.getElementById('chatList') as HTMLElement | null,
  chatName: document.getElementById('chatNameInput') as HTMLInputElement | null,
  chatCreate: document.getElementById('createChatButton') as HTMLButtonElement | null,

  chatHistory: document.getElementById('chatHistory') as HTMLElement | null,
}

/* ==============================
   State
   ============================== */
let anamClient: AnamClient | null = null
let selectedModel = '' // выбирается из селекта
let currentChat: string | null = null
let isRecording = false
let activeES: EventSource | null = null

// live-транскрипт во время записи (растущий)
let liveTranscript = ''
let liveUserBubble: HTMLDivElement | null = null
let anamListenersBound = false
let baselineUserJoined: string | null = null

// мобильный «анлок» медиа
let mediaUnlocked = false

/* ==============================
   Types + storage helpers
   ============================== */
type ChatMessage = { role: 'user' | 'assistant'; content: string; ts: number }
type ChatData = { messages: ChatMessage[] }

function getChatData(name: string): ChatData {
  try {
    const raw = localStorage.getItem(name)
    if (!raw) return { messages: [] }
    const parsed = JSON.parse(raw)
    if (!parsed?.messages) return { messages: [] }
    return parsed
  } catch {
    return { messages: [] }
  }
}
function setChatData(name: string, data: ChatData) {
  localStorage.setItem(name, JSON.stringify(data))
}
function savedChatNames(): string[] {
  try { return JSON.parse(localStorage.getItem('chatNames') || '[]') } catch { return [] }
}
function setSavedChatNames(names: string[]) {
  localStorage.setItem('chatNames', JSON.stringify(names))
}

/* ==============================
   Guards
   ============================== */
function clientOrThrow(): AnamClient {
  if (!anamClient) throw new Error('Avatar session not initialized')
  return anamClient
}
async function ensureClient(): Promise<AnamClient> {
  if (!anamClient) await initializeAvatarSession()
  if (!anamClient) throw new Error('Failed to initialize avatar session')
  return anamClient
}

/* ==============================
   Мобильный медиахендшейк
   ============================== */
function attachOneTimeUnlockHandlers() {
  const unlock = async () => {
    await unlockMediaPlayback()
    document.removeEventListener('touchend', unlock)
    document.removeEventListener('click', unlock)
  }
  document.addEventListener('touchend', unlock, { passive: true, once: true })
  document.addEventListener('click', unlock, { once: true })
}

async function unlockMediaPlayback() {
  if (mediaUnlocked) return
  mediaUnlocked = true
  try {
    // Разблокируем AudioContext
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext
    if (AC) {
      const ctx = new AC()
      if (ctx.state !== 'running') await ctx.resume()
    }
  } catch {}
  try {
    // Разрешаем muted-воспроизведение видео (iOS/Android)
    if (el.video) {
      el.video.muted = true
      el.video.setAttribute('playsinline', '')
      await el.video.play().catch(() => {})
    }
  } catch {}
}

/* ==============================
   UI: список чатов
   ============================== */
function addChatItem(name: string) {
  if (!el.chatList) return
  const li = document.createElement('li')
  li.addEventListener('click', () => loadChat(name))

  const span = document.createElement('span')
  span.textContent = name

  const box = document.createElement('div')
  box.className = 'dropdown-container'

  const dots = document.createElement('button')
  dots.className = 'dots-button'
  dots.textContent = '⋮'

  const menu = document.createElement('div')
  menu.className = 'dropdown-menu'

  const rename = document.createElement('button')
  rename.textContent = 'Rename'
  rename.addEventListener('click', (e) => {
    e.stopPropagation()
    const nn = prompt('New name for chat', name) || name
    if (nn && nn !== name) {
      const data = localStorage.getItem(name)
      if (data) {
        localStorage.setItem(nn, data)
        localStorage.removeItem(name)
      }
      setSavedChatNames(savedChatNames().map((n) => (n === name ? nn : n)))
      span.textContent = nn
      if (currentChat === name) currentChat = nn
    }
    menu.classList.remove('active')
  })

  const del = document.createElement('button')
  del.textContent = 'Delete'
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    li.remove()
    localStorage.removeItem(name)
    setSavedChatNames(savedChatNames().filter((n) => n !== name))
    if (currentChat === name) {
      currentChat = null
      renderEmptyState()
    }
  })

  dots.addEventListener('click', (e) => {
    e.stopPropagation()
    document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'))
    menu.classList.toggle('active')
  })

  menu.appendChild(rename)
  menu.appendChild(del)
  box.appendChild(dots)
  box.appendChild(menu)
  li.appendChild(span)
  li.appendChild(box)
  el.chatList.appendChild(li)
}

function loadChatList() {
  if (!el.chatList) return
  el.chatList.innerHTML = ''
  savedChatNames().forEach(addChatItem)
}

/* ==============================
   UI: история сообщений
   ============================== */
function renderEmptyState() {
  if (el.chatHistory) {
    el.chatHistory.style.display = 'none'
    el.chatHistory.innerHTML = ''
  }
  if (el.chatMsg) el.chatMsg.style.display = ''
}

function renderChatHistory(name: string) {
  if (!el.chatHistory) return
  const data = getChatData(name)
  el.chatHistory.innerHTML = ''
  data.messages.forEach(m => appendMessageBubble(m.role, m.content, false))
  el.chatMsg && (el.chatMsg.style.display = 'none')
  el.chatHistory.style.display = 'block'
}

function appendMessageBubble(role: 'user'|'assistant', text: string, streaming: boolean): HTMLDivElement {
  if (!el.chatHistory) throw new Error('chatHistory not found')
  const wrap = document.createElement('div')
  wrap.className = `message ${role === 'user' ? 'outgoing' : 'incoming'}`
  const bubble = document.createElement('div')
  bubble.className = `message-bubble ${role === 'user' ? 'outgoing' : 'incoming'}`
  bubble.textContent = text
  wrap.appendChild(bubble)
  el.chatHistory.appendChild(wrap)
  el.chatHistory.scrollTop = el.chatHistory.scrollHeight
  if (streaming) bubble.setAttribute('data-streaming', 'true')
  return bubble
}
function addPersistedMessage(role: 'user'|'assistant', content: string) {
  if (!currentChat) return
  const data = getChatData(currentChat)
  data.messages.push({ role, content, ts: Date.now() })
  setChatData(currentChat, data)
}

/* ==============================
   Создание/загрузка чата
   ============================== */
function createChat() {
  if (!selectedModel) { alert('Choose your persona first'); return }
  const name = (el.chatName?.value || '').trim()
  if (!name) return
  const names = savedChatNames()
  if (!names.includes(name)) {
    names.push(name)
    setSavedChatNames(names)
  }
  if (!localStorage.getItem(name)) setChatData(name, { messages: [] })
  if (el.chatName) el.chatName.value = ''
  addChatItem(name)
  loadChat(name)
}

async function loadChat(name: string) {
  if (!selectedModel) { alert('Choose your persona first'); return }
  currentChat = name
  renderChatHistory(name)
  await initializeAvatarSession()
}

/* ==============================
   ANAM session
   ============================== */
function personaIdFromModel(model: string) {
  if (model === 'NICK_MODEL') return LEO_PERSONA_ID
  if (model === 'JOHN_PULSE_MODEL') return PABLO_PERSONA_ID
  return EVA_PERSONA_ID // по умолчанию (Maria/Vasilisa)
}

async function fetchAnamSessionToken(personaId: string): Promise<string> {
  const res = await fetch(`${ANAM_PROXY_BASE}/v1/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaConfig: { personaId, disableBrains: true } }),
  })
  if (!res.ok) throw new Error('ANAM token error: ' + res.status + ' ' + (await res.text()))
  const j = await res.json()
  return j.sessionToken
}

function extractText(val: any): string {
  if (!val) return ''
  if (typeof val === 'string') return val
  if (Array.isArray(val)) return val.map(extractText).filter(Boolean).join(' ')
  if (typeof val === 'object') {
    if (typeof (val as any).text === 'string') return (val as any).text
    if (typeof (val as any).content === 'string') return (val as any).content
    if (Array.isArray((val as any).content)) return extractText((val as any).content)
  }
  return ''
}
function joinedUserText(messages: any[]): string {
  const parts: string[] = []
  for (const m of messages || []) {
    if (m?.role === 'user') {
      const t = extractText(m.content).trim()
      if (t) parts.push(t)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
function lcpLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

async function initializeAvatarSession() {
  if (!el.videoWrap || !el.spinner || !el.chatMsg || !el.mic) return

  // показать видео-контейнер и спиннер
  el.videoWrap.style.display = 'flex'
  el.videoWrap.classList.add('loading')
  el.spinner.style.display = 'block'
  el.chatMsg.style.display = 'none'
  el.mic.style.display = 'flex'
  el.chatHistory && (el.chatHistory.style.display = 'block')

  // На мобильных — сразу подвешиваем one-time unlock
  attachOneTimeUnlockHandlers()

  const personaId = personaIdFromModel(selectedModel)
  const token = await fetchAnamSessionToken(personaId)

  // SDK (REST+WS) — напрямую в Anam
  anamClient = (createClient as any)(token, {
    baseUrl: ANAM_DIRECT_BASE,
    apiBaseUrl: ANAM_DIRECT_BASE,
  })

  const client = clientOrThrow()

  // Автоплей на iOS/Android: сначала muted
  if (el.video) {
    el.video.muted = true
    el.video.playsInline = true
    el.video.autoplay = true
  }

  client.streamToVideoElement('avatarVideo')

  // Сразу пытаемся "подтолкнуть" воспроизведение (в т.ч. на 4G)
  try { await el.video?.play() } catch {}
  // Ретраи на случай, если медиапоток пришёл позже
  setTimeout(() => { el.video?.play().catch(() => {}) }, 400)
  setTimeout(() => { el.video?.play().catch(() => {}) }, 1200)

  client.muteInputAudio() // микрофон выключен, пока не нажали кнопку

  // Когда видео реально заиграет — убираем лоадер
  client.addListener('VIDEO_PLAY_STARTED' as any, () => {
    if (!el.spinner || !el.videoWrap) return
    el.spinner.style.display = 'none'
    el.videoWrap.classList.remove('loading')
  })
  el.video?.addEventListener('canplaythrough', () => {
    if (!el.spinner || !el.videoWrap) return
    el.spinner.style.display = 'none'
    el.videoWrap.classList.remove('loading')
  })
  setTimeout(() => {
    if (!el.spinner || !el.videoWrap) return
    el.spinner.style.display = 'none'
    el.videoWrap.classList.remove('loading')
  }, 5000)

  // Привязываем слушатели один раз
  if (!anamListenersBound) {
    anamListenersBound = true

    // Реал-тайм транскрипт: растущий, не затирающий
    client.addListener('MESSAGE_HISTORY_UPDATED' as any, (messages: any[]) => {
      if (!isRecording) return
      const full = joinedUserText(messages)
      if (baselineUserJoined === null) {
        baselineUserJoined = full
        if (!liveUserBubble) liveUserBubble = appendMessageBubble('user', '', true)
        return
      }
      const base = baselineUserJoined
      const lcp = lcpLen(full, base)
      let suffix = full.slice(lcp).trimStart()
      if (full.length < base.length) suffix = ''
      if (suffix) {
        liveTranscript = suffix
        if (!liveUserBubble) liveUserBubble = appendMessageBubble('user', '', true)
        liveUserBubble.textContent = liveTranscript
        el.chatHistory && (el.chatHistory.scrollTop = el.chatHistory.scrollHeight)
      }
    })

    client.addListener('ERROR' as any, (e: any) => {
      console.error('[ANAM ERROR]', e)
      alert('Не удалось запустить сессию аватара. Подробности в консоли.')
    })
  }

  // На случай скрытия/возврата вкладки в мобилке — пробуем заново проиграть
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      el.video?.play().catch(() => {})
    }
  })
}

async function terminateAvatarSession() {
  try {
    if (activeES) { try { activeES.close() } catch {} ; activeES = null }
    await anamClient?.stopStreaming?.()
  } catch {}
  anamClient = null
  if (el.mic) el.mic.style.display = 'none'
}

/* ==============================
   Voice controls
   ============================== */
async function startRecording() {
  const client = await ensureClient()

  // На мобильных: перед началом записи — точно делаем unlock
  await unlockMediaPlayback()

  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext
    if (AC) {
      const ac = new AC()
      if (ac.state === 'suspended') await ac.resume()
    }
  } catch {}

  // Если хочешь, чтобы аватар был слышен до записи, можно размутить здесь:
  // el.video && (el.video.muted = false)

  client.unmuteInputAudio()
  isRecording = true
  liveTranscript = ''
  baselineUserJoined = null
  if (!liveUserBubble) liveUserBubble = appendMessageBubble('user', '', true)
  el.mic?.classList.add('active')
}

async function stopRecording() {
  const client = clientOrThrow()
  client.muteInputAudio()
  isRecording = false
  el.mic?.classList.remove('active')

  const text = liveTranscript.trim()
  if (liveUserBubble) {
    liveUserBubble.removeAttribute('data-streaming')
    if (text) liveUserBubble.textContent = text
  }
  if (text && currentChat) addPersistedMessage('user', text)

  liveUserBubble = null
  baselineUserJoined = null
  const utterance = text
  liveTranscript = ''

  if (utterance) await handleUserTranscript(utterance)
}

async function toggleRecording() {
  await ensureClient()
  if (isRecording) await stopRecording()
  else await startRecording()
}

/* ==============================
   Model → avatar streaming (OpenAI → speech)
   ============================== */
async function handleUserTranscript(transcript: string) {
  const client = await ensureClient()

  try { (client as any).interruptPersona?.() } catch {}

  if (activeES) { try { activeES.close() } catch {} ; activeES = null }

  const bubble = appendMessageBubble('assistant', '', true)
  let assistantBuffer = ''

  const talk = client.createTalkMessageStream()
  const url = `/api/generate-assistant-response?prompt=${encodeURIComponent(transcript)}&model=${encodeURIComponent(selectedModel)}&t=${Date.now()}`
  const es = new EventSource(url)
  activeES = es

  // На время ответа — размутим видео, чтобы точно был звук
  if (el.video) el.video.muted = false

  es.onmessage = async (ev) => {
    const chunk = ev.data
    if (chunk === '__END_OF_STREAM__') {
      es.close()
      if (activeES === es) activeES = null
      if (talk?.isActive()) await talk.endMessage()

      bubble.removeAttribute('data-streaming')
      addPersistedMessage('assistant', assistantBuffer.trim())
      return
    }
    assistantBuffer += chunk
    bubble.textContent = assistantBuffer
    if (talk?.isActive()) talk.streamMessageChunk(chunk, false)
    el.chatHistory && (el.chatHistory.scrollTop = el.chatHistory.scrollHeight)
  }

  es.onerror = () => {
    try { es.close() } catch {}
    if (activeES === es) activeES = null
    if (talk?.isActive()) talk.endMessage()
    bubble.removeAttribute('data-streaming')
    if (!assistantBuffer) bubble.textContent = 'Ошибка соединения. Попробуйте ещё раз.'
  }
}

/* ==============================
   Wire UI
   ============================== */
function onBurgerClick(e: Event) {
  e.preventDefault()
  e.stopPropagation()
  if (!el.sidebar) return
  el.sidebar.classList.toggle('visible')
}
if (el.burger) {
  el.burger.addEventListener('click', onBurgerClick)
  el.burger.addEventListener('pointerup', onBurgerClick)
}

el.persona?.addEventListener('change', () => {
  selectedModel = el.persona!.value
  if (anamClient) initializeAvatarSession().catch(console.error)
})

el.chatCreate?.addEventListener('click', createChat)
el.mic?.addEventListener('click', toggleRecording)

// Закрывать открытые меню по клику вне
document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'))
})

window.addEventListener('load', () => {
  loadChatList()
  renderEmptyState()
  // iOS-friendly autoplay: на всякий
  el.video?.setAttribute('playsinline', '')
  el.video?.setAttribute('autoplay', '')
  if (el.video) el.video.muted = true
  attachOneTimeUnlockHandlers()
})

window.addEventListener('beforeunload', () => {
  try { if (activeES) activeES.close() } catch {}
})
