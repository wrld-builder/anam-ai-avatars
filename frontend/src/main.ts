// src/main.ts
import { createClient, AnamClient } from '@anam-ai/js-sdk'
import { AnamEvent } from '@anam-ai/js-sdk/dist/module/types'
import { EVA_PERSONA_ID, LEO_PERSONA_ID, PABLO_PERSONA_ID } from './lib/constants'

/* ==============================
   Маршруты и патчи сетевых вызовов
   ============================== */
const ANAM_BASE   = '/anam/api'
const ANAM_ORIGIN = 'https://api.anam.ai'

// Проксируем ВСЕ вызовы SDK к Anam через наш бэкенд
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
        })
      } else {
        input = url
      }
    }
    return origFetch(input as any, init)
  }

  const OrigES = window.EventSource
  class PatchedEventSource extends OrigES {
    constructor(url: string | URL, opts?: EventSourceInit) {
      const u = typeof url === 'string' ? url : url.href
      super(u.startsWith(ANAM_ORIGIN) ? u.replace(ANAM_ORIGIN, ANAM_BASE) : u, opts)
    }
  }
  ;(window as any).EventSource = PatchedEventSource
})()

/* ==============================
   DOM
   ============================== */
const el = {
  video: document.getElementById('avatarVideo') as HTMLVideoElement,
  listenBtn: document.getElementById('listenButton') as HTMLButtonElement,
  chatHistory: document.getElementById('chatHistory') as HTMLElement,
  chatList: document.getElementById('chatList') as HTMLElement,
  chatName: document.getElementById('chatNameInput') as HTMLInputElement,
  chatCreate: document.getElementById('createChatButton') as HTMLButtonElement,
  videoWrap: document.getElementById('videoContainer') as HTMLElement,
  spinner: document.getElementById('loading-spinner') as HTMLElement,
  exportBtn: document.getElementById('exportButton') as HTMLElement,
  persona: document.getElementById('personaSelect') as HTMLSelectElement,
  chatMsg: document.getElementById('chatMsg') as HTMLElement,
}

/* ==============================
   Состояние
   ============================== */
let anamClient: AnamClient | null = null
let selectedPersona = ''           // модель/персона
let currentChat: string | null = null
let isRecording = false
let userTranscript = ''
let currentUserBubble: HTMLDivElement | null = null
let activeES: EventSource | null = null
let sessionTimer: number | null = null

/* ==============================
   Хелперы
   ============================== */
type AnamSessionTokenResponse = { sessionToken: string; expiresAt?: string }

async function fetchAnamSessionToken(personaId: string): Promise<string> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 15000)
  const res = await fetch(`${ANAM_BASE}/v1/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ personaConfig: { personaId, disableBrains: true } }),
  }).catch((e) => { throw new Error(`ANAM token fetch failed: ${e}`) })
  clearTimeout(t)
  if (!res.ok) throw new Error(`ANAM token error: ${res.status} ${await res.text().catch(()=>'')}`)
  const data = (await res.json()) as AnamSessionTokenResponse
  if (!data?.sessionToken) throw new Error('ANAM token error: empty payload')
  return data.sessionToken
}

function personaIdFromModel(model: string) {
  if (model === 'NICK_MODEL') return LEO_PERSONA_ID
  if (model === 'JOHN_PULSE_MODEL') return PABLO_PERSONA_ID
  return EVA_PERSONA_ID
}

function startSessionTimer() {
  if (sessionTimer) clearTimeout(sessionTimer)
  sessionTimer = window.setTimeout(() => {
    terminateAvatarSession()
    alert('Сессия завершена по таймауту.')
  }, 5 * 60 * 1000)
}

function appendBubble(role: 'user' | 'assistant', text: string, streaming = false) {
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
   Сессия ANAM (запуск ТОЛЬКО при выбранном чате)
   ============================== */
async function initializeAvatarSession() {
  if (!selectedPersona || !currentChat) return           // ← важный стоп
  if (anamClient) return                                  // не дублируем

  // UI: показать контейнер, спиннер
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

  // Настройки видео
  el.video.playsInline = true
  el.video.autoplay = true
  el.video.muted = false

  anamClient?.streamToVideoElement('avatarVideo')
  anamClient?.muteInputAudio()

  // события
  anamClient?.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => {
    el.spinner.style.display = 'none'
    el.videoWrap.classList.remove('loading')
  })
  anamClient?.addListener(AnamEvent.MESSAGE_HISTORY_UPDATED, (messages: any[]) => {
    if (!isRecording || !currentUserBubble) return
    const last = messages[messages.length - 1]
    if (last?.role === 'user' && last?.content) {
      userTranscript += ' ' + last.content
      currentUserBubble.textContent = userTranscript.trim()
      el.chatHistory.scrollTop = el.chatHistory.scrollHeight
    }
  })

  startSessionTimer()
}

async function terminateAvatarSession() {
  try { activeES?.close() } catch {}
  activeES = null
  try { await anamClient?.stopStreaming?.() } catch {}
  anamClient = null
  isRecording = false
  el.listenBtn.classList.remove('active')
  el.listenBtn.style.display = 'none'
  // спиннер на всякий скрываем
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
    if (AC) {
      const ac = new AC()
      if (ac.state === 'suspended') await ac.resume()
    }
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
   Генерация ответа (SSE) + озвучка
   ============================== */
async function handleUserTranscript(transcript: string) {
  if (!transcript) return
  if (!anamClient) await initializeAvatarSession()
  if (!anamClient) return

  const bubble = appendBubble('assistant', '', true)
  const talk = anamClient.createTalkMessageStream?.()
  let buffer = ''
  let rafLock = false

  const url = `/api/generate-assistant-response?prompt=${encodeURIComponent(transcript)}&model=${encodeURIComponent(selectedPersona)}&t=${Date.now()}`
  const es = new EventSource(url)
  activeES = es

  el.video.muted = false // чтобы ответ точно был слышен

  es.onmessage = async (ev) => {
    const chunk = ev.data
    if (chunk === '__END_OF_STREAM__') {
      es.close()
      if (activeES === es) activeES = null
      if (talk?.isActive()) await talk.endMessage()
      bubble.removeAttribute('data-streaming')
      bubble.textContent = buffer.trim()
      return
    }
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
      if (data) { localStorage.setItem(nn, data); localStorage.removeItem(name) }
      const list: string[] = JSON.parse(localStorage.getItem('chatNames') || '[]')
      localStorage.setItem('chatNames', JSON.stringify(list.map(n => n === name ? nn : n)))
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
    const list: string[] = JSON.parse(localStorage.getItem('chatNames') || '[]')
    localStorage.setItem('chatNames', JSON.stringify(list.filter(n => n !== name)))
    if (currentChat === name) {
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

  menu.appendChild(rename)
  menu.appendChild(del)
  box.appendChild(dots)
  box.appendChild(menu)
  li.appendChild(span)
  li.appendChild(box)
  el.chatList.appendChild(li)
}

function createChat() {
  if (!selectedPersona) { alert('Сначала выберите персону.'); return }
  const name = (el.chatName.value || '').trim()
  if (!name) return
  const chats = new Set<string>(JSON.parse(localStorage.getItem('chatNames') || '[]'))
  chats.add(name)
  localStorage.setItem('chatNames', JSON.stringify(Array.from(chats)))
  localStorage.setItem(name, JSON.stringify({ messages: [] }))
  el.chatName.value = ''
  addChatItem(name)
  selectChat(name)
}

function selectChat(name: string) {
  currentChat = name
  localStorage.setItem('currentChat', name)
  // перерисовать историю
  el.chatHistory.innerHTML = ''
  const data = JSON.parse(localStorage.getItem(name) || '{"messages":[]}')
  for (const m of (data.messages || [])) appendBubble(m.role, m.content, false)

  // запуск сессии — ТОЛЬКО сейчас
  initializeAvatarSession().catch(console.error)
}

/* ==============================
   Wire UI
   ============================== */
document.getElementById('burgerMenu')?.addEventListener('click', (e) => {
  e.preventDefault(); e.stopPropagation()
  document.getElementById('sidebar')?.classList.toggle('visible')
})

el.persona.addEventListener('change', async () => {
  // только меняем выбранную персону, НО НЕ ЗАПУСКАЕМ СЕССИЮ
  selectedPersona = el.persona.value

  // если была активная сессия — завершаем
  if (anamClient) await terminateAvatarSession()

  // сбрасываем UI к состоянию «выберите чат»
  el.spinner.style.display = 'none'
  el.videoWrap.classList.remove('loading')
  el.listenBtn.style.display = 'none'
  el.chatMsg.style.display = ''
  el.chatHistory.style.display = 'none'
})

el.chatCreate.addEventListener('click', createChat)
el.listenBtn.addEventListener('click', toggleRecording)
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

window.addEventListener('load', () => {
  // iOS-friendly
  el.video.setAttribute('playsinline', '')
  el.video.setAttribute('autoplay', '')
  el.video.muted = false

  // загрузить список чатов
  loadChats()

  // восстановить выбранный чат (если был)
  const saved = localStorage.getItem('currentChat')
  if (saved) selectChat(saved)
})
