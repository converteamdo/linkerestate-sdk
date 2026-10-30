/**
 * Cloudflare Turnstile for the browser: loads Cloudflare's script once, renders the widget
 * invisible ("interaction-only") and shows it only while Cloudflare needs the visitor to act.
 *
 * The widget is rendered explicitly, so every callback is a closure on this module — nothing is
 * looked up by name on `window`, and a challenge solved before the page finished hydrating keeps
 * its token.
 *
 * Visibility is exposed as attributes on the container, so each site styles it with its own
 * tokens: `data-challenge-shown` while the widget renders something, `data-challenge-done` once
 * a challenge the visitor solved has had a moment to show its check mark.
 */

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
const STYLE_ID = "linkerestate-challenge-style"
/** How long a solved challenge keeps showing Cloudflare's «Success» before it collapses. */
const DONE_DELAY_MS = 1500

/**
 * Placement of the widget:
 * - `inline` sits where its container is, and leaves the layout while it renders nothing.
 * - `floating` is a card fixed at the bottom centre of the screen, for challenges that guard a
 *   button (WhatsApp, phone) or a form with no room for one (a horizontal hero bar).
 */
export type ChallengePlacement = "inline" | "floating"

export interface ChallengeOptions {
  /** The Turnstile site key. Public — it ships to the browser. */
  siteKey: string
  /** Default `inline`. */
  placement?: ChallengePlacement
  /** Default `auto` (follows the visitor's system). */
  theme?: "light" | "dark" | "auto"
  /** Two-letter language for the widget's text. Default: the browser's. */
  language?: string
  /** Turnstile `action`, shown in Cloudflare's analytics (e.g. `"lead-form"`, `"watel"`). */
  action?: string
}

export interface Challenge {
  /** The element the widget lives in — the container passed, or the floating card. */
  readonly element: HTMLElement
  /** The current token, or null while there is none (not solved yet, expired, failed). */
  getToken(): string | null
  /**
   * Resolves with a token as soon as there is one, or null after `timeoutMs` (default 8000).
   * A visible challenge waits for the visitor, so pass a longer timeout when that matters.
   */
  waitForToken(timeoutMs?: number): Promise<string | null>
  /**
   * Returns the current token and starts a fresh challenge. A token is single-use: take it for
   * each submission or click, never send the same one twice.
   */
  takeToken(): string | null
  /** Starts a fresh challenge, discarding the current token. */
  reset(): void
  /** Removes the widget (and the floating card, when the SDK created it). */
  remove(): void
}

interface TurnstileRenderOptions {
  sitekey: string
  appearance: "interaction-only"
  theme?: "light" | "dark" | "auto"
  language?: string
  action?: string
  callback: (token: string) => void
  "expired-callback": () => void
  "error-callback": () => void
  "before-interactive-callback": () => void
  "after-interactive-callback": () => void
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined
  reset(widgetId: string): void
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptLoad: Promise<TurnstileApi> | null = null

/** Loads Cloudflare's script once per page; reuses one the page already includes. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptLoad) return scriptLoad
  scriptLoad = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]'
    )
    const script = existing ?? document.createElement("script")
    const done = () => {
      if (window.turnstile) resolve(window.turnstile)
      else reject(new Error("Turnstile script loaded without window.turnstile"))
    }
    script.addEventListener("load", done, { once: true })
    script.addEventListener(
      "error",
      () => {
        scriptLoad = null
        reject(new Error("Turnstile script failed to load"))
      },
      { once: true }
    )
    if (!existing) {
      script.src = SCRIPT_URL
      script.async = true
      document.head.appendChild(script)
    }
  })
  return scriptLoad
}

/**
 * The SDK's only CSS: hiding a widget that renders nothing, and the floating card's position.
 * Everything cosmetic sits under `:where()` (zero specificity), so a site's own rule wins.
 */
function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement("style")
  style.id = STYLE_ID
  style.textContent = `
[data-challenge]:not([data-challenge-shown]),
[data-challenge][data-challenge-done] {
  opacity: 0;
  pointer-events: none;
}
[data-challenge="inline"]:not([data-challenge-shown]),
[data-challenge="inline"][data-challenge-done] {
  position: absolute !important;
  margin: 0 !important;
  padding: 0 !important;
}
[data-challenge="floating"] {
  position: fixed !important;
  left: 50%;
  bottom: 1rem;
  z-index: 2147483000;
  transform: translateX(-50%);
  transition: opacity 0.3s ease;
}
:where([data-challenge="floating"][data-challenge-shown]) {
  padding: 0.5rem;
  background: #fff;
  border-radius: 0.75rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}`
  document.head.appendChild(style)
}

/**
 * Renders a Turnstile widget. `container` is where an `inline` widget sits; a `floating` one
 * creates its own card when `container` is null.
 *
 * Fails soft: if Cloudflare's script cannot load, the challenge simply never yields a token, and
 * the server decides what a submission without one means.
 */
export function mountChallenge(
  container: HTMLElement | null,
  options: ChallengeOptions
): Challenge {
  const placement = options.placement ?? "inline"
  const ownsElement = !container
  const element = container ?? document.createElement("div")
  if (ownsElement) document.body.appendChild(element)
  element.dataset.challenge = placement
  injectStyle()

  let widgetId: string | undefined
  let token: string | null = null
  let removed = false
  let doneTimer: ReturnType<typeof setTimeout> | undefined
  const waiters = new Set<(token: string) => void>()

  // The widget's own height is what says whether it shows something: interaction-only renders
  // nothing until Cloudflare asks for an interaction, and its callbacks carry no such signal.
  const mount = document.createElement("div")
  element.appendChild(mount)
  const observer = new ResizeObserver((entries) => {
    const shown = entries.some((entry) => entry.contentRect.height > 0)
    element.toggleAttribute("data-challenge-shown", shown)
  })
  observer.observe(mount)

  const clearToken = () => {
    token = null
  }

  void loadTurnstile()
    .then((turnstile) => {
      if (removed) return
      widgetId = turnstile.render(mount, {
        sitekey: options.siteKey,
        appearance: "interaction-only",
        theme: options.theme ?? "auto",
        ...(options.language ? { language: options.language } : {}),
        ...(options.action ? { action: options.action } : {}),
        callback: (value) => {
          token = value
          waiters.forEach((resolve) => resolve(value))
          waiters.clear()
        },
        "expired-callback": clearToken,
        "error-callback": clearToken,
        "before-interactive-callback": () => {
          clearTimeout(doneTimer)
          element.removeAttribute("data-challenge-done")
        },
        "after-interactive-callback": () => {
          clearTimeout(doneTimer)
          doneTimer = setTimeout(
            () => element.setAttribute("data-challenge-done", ""),
            DONE_DELAY_MS
          )
        },
      })
    })
    .catch((error: unknown) => {
      console.warn("[linkerestate] challenge unavailable:", error)
    })

  const reset = () => {
    token = null
    if (widgetId !== undefined) {
      try {
        window.turnstile?.reset(widgetId)
      } catch {
        // A widget already gone has nothing to reset.
      }
    }
  }

  return {
    element,
    getToken: () => token,
    waitForToken(timeoutMs = 8000) {
      if (token) return Promise.resolve(token)
      return new Promise<string | null>((resolve) => {
        const onToken = (value: string) => {
          clearTimeout(timer)
          resolve(value)
        }
        const timer = setTimeout(() => {
          waiters.delete(onToken)
          resolve(null)
        }, timeoutMs)
        waiters.add(onToken)
      })
    },
    takeToken() {
      const current = token
      if (current) reset()
      return current
    },
    reset,
    remove() {
      removed = true
      clearTimeout(doneTimer)
      observer.disconnect()
      waiters.clear()
      if (widgetId !== undefined) {
        try {
          window.turnstile?.remove(widgetId)
        } catch {
          // Already removed.
        }
      }
      mount.remove()
      if (ownsElement) element.remove()
      else {
        delete element.dataset.challenge
        element.removeAttribute("data-challenge-shown")
        element.removeAttribute("data-challenge-done")
      }
    },
  }
}
