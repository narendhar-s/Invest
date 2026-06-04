// notify.ts — lightweight in-app toast + sound + OS Web Notifications.
//
// No external deps: toasts are injected into a fixed container, the beep uses
// the Web Audio API, and desktop alerts use the Notifications API (with the
// user's permission). Designed for trade-call alerts on the Live page.

export type ToastKind = 'buy' | 'sell' | 'neutral' | 'info'

let container: HTMLDivElement | null = null
let audioCtx: AudioContext | null = null

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;top:72px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;'
  document.body.appendChild(el)
  container = el
  return el
}

const COLORS: Record<ToastKind, string> = {
  buy: '#34d399',
  sell: '#f87171',
  neutral: '#94a3b8',
  info: '#60a5fa',
}

export function showToast(title: string, body: string, kind: ToastKind = 'info', ttlMs = 6000) {
  const root = ensureContainer()
  const card = document.createElement('div')
  const accent = COLORS[kind]
  card.style.cssText = `pointer-events:auto;min-width:240px;max-width:340px;background:#0f172a;border:1px solid ${accent}55;border-left:4px solid ${accent};border-radius:10px;padding:10px 12px;color:#e2e8f0;box-shadow:0 8px 24px rgba(0,0,0,.35);font-family:inherit;opacity:0;transform:translateX(12px);transition:opacity .2s,transform .2s;`
  card.innerHTML =
    `<div style="font-size:13px;font-weight:600;color:${accent};margin-bottom:2px">${escapeHtml(title)}</div>` +
    `<div style="font-size:12px;color:#cbd5e1;line-height:1.35">${escapeHtml(body)}</div>`
  root.appendChild(card)
  requestAnimationFrame(() => {
    card.style.opacity = '1'
    card.style.transform = 'translateX(0)'
  })
  const remove = () => {
    card.style.opacity = '0'
    card.style.transform = 'translateX(12px)'
    setTimeout(() => card.remove(), 220)
  }
  card.addEventListener('click', remove)
  setTimeout(remove, ttlMs)
}

// playBeep emits a short two-tone chime. up=true for BUY, false for SELL.
export function playBeep(up = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || (window as any).webkitAudioContext)()
    const ctx = audioCtx
    const now = ctx.currentTime
    const freqs = up ? [660, 990] : [520, 390]
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.0001, now + i * 0.12)
      gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.12 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + i * 0.12)
      osc.stop(now + i * 0.12 + 0.12)
    })
  } catch {
    /* audio unavailable — ignore */
  }
}

// requestNotificationPermission asks for OS notification permission once.
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const res = await Notification.requestPermission()
  return res === 'granted'
}

// showDesktopNotification fires an OS notification if permission was granted.
export function showDesktopNotification(title: string, body: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, tag: 'stockwise-call' })
  } catch {
    /* ignore */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}
