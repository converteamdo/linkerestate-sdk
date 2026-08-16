/** Agent rotation for WhatsApp and phone CTAs. Runs in the browser. */

import { normalizeBaseUrl, request, type BaseConfig } from "./core.js"

export { LinkerestateError } from "./core.js"

export interface RoundRobinConfig extends BaseConfig {
  /** Campaign UUID the rotation belongs to. */
  campaignId: string
  /** A `campaign_rr` key. Public — it is meant to ship to the browser. */
  apiKey: string
  /** Campaign source `webhook_key`, sent as click attribution. */
  source?: string
}

export interface NextAgent {
  waUrl?: string
  telUrl?: string
  phone?: string
}

export type CtaChannel = "whatsapp" | "tel"

/** Elements the commit handler binds to. */
const SELECTORS: Record<CtaChannel, string> = {
  whatsapp: '[id^="wa-btn"], [data-rr-link="whatsapp"]',
  tel: '[id^="tel-btn"], [data-rr-link="tel"]',
}

export interface RoundRobinClient {
  /** Reads the agent on turn without consuming the slot. */
  peek(): Promise<NextAgent | null>
  /**
   * Binds click handlers that commit the assignment without blocking
   * navigation. Returns a cleanup function; each element is bound once.
   */
  attachCommitHandlers(root?: ParentNode): () => void
}

export function createRoundRobinClient(config: RoundRobinConfig): RoundRobinClient {
  const base = normalizeBaseUrl(config.baseUrl)
  const endpoint = `${base}/rr/${config.campaignId}`

  function commitUrl(channel: CtaChannel): string {
    const url = new URL(endpoint)
    url.searchParams.set("type", channel)
    url.searchParams.set("key", config.apiKey)
    if (config.source) url.searchParams.set("source", config.source)
    return url.toString()
  }

  return {
    async peek() {
      try {
        return await request<NextAgent>(endpoint, {
          query: { key: config.apiKey },
          timeoutMs: 4500,
        })
      } catch {
        // Fail soft: the CTAs keep the hrefs the page rendered.
        return null
      }
    },

    attachCommitHandlers(root: ParentNode = document) {
      const cleanups: Array<() => void> = []
      for (const channel of Object.keys(SELECTORS) as CtaChannel[]) {
        for (const el of Array.from(root.querySelectorAll<HTMLElement>(SELECTORS[channel]))) {
          if (el.dataset.rrCommitAttached === "true") continue
          el.dataset.rrCommitAttached = "true"
          const onClick = () => {
            const url = commitUrl(channel)
            if (navigator.sendBeacon) navigator.sendBeacon(url)
            else void fetch(url, { method: "POST", keepalive: true }).catch(() => {})
          }
          el.addEventListener("click", onClick)
          cleanups.push(() => {
            el.removeEventListener("click", onClick)
            delete el.dataset.rrCommitAttached
          })
        }
      }
      return () => cleanups.forEach((fn) => fn())
    },
  }
}
