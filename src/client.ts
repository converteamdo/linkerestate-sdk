/**
 * Browser surface: agent rotation for WhatsApp / phone CTAs.
 *
 * The key this entry point takes is public by construction — it ends up in the
 * page source, and that is fine: it can only read the next agent and record a
 * click. Lead submission lives in `@linkerestate/sdk/server` precisely so its
 * credential can never be bundled into a browser build by accident.
 */

import { normalizeBaseUrl, request, type BaseConfig } from "./core.js"

export { LinkerestateError } from "./core.js"

export interface RoundRobinConfig extends BaseConfig {
  /** Campaign UUID the rotation belongs to. */
  campaignId: string
  /** A `campaign_rr` key. Public — it is meant to ship to the browser. */
  apiKey: string
  /**
   * `webhook_key` of the campaign source, forwarded as click attribution so a
   * commit can be traced back to the form it came from. Not a credential.
   */
  source?: string
}

export interface NextAgent {
  waUrl?: string
  telUrl?: string
  phone?: string
}

export type CtaChannel = "whatsapp" | "tel"

/** Elements the commit handler binds to, matching the platform's own markup. */
const SELECTORS: Record<CtaChannel, string> = {
  whatsapp: '[id^="wa-btn"], [data-rr-link="whatsapp"]',
  tel: '[id^="tel-btn"], [data-rr-link="tel"]',
}

export interface RoundRobinClient {
  /** Reads the agent on turn without consuming the slot. */
  peek(): Promise<NextAgent | null>
  /**
   * Binds click handlers that commit the assignment. Fire-and-forget via
   * `sendBeacon` so navigation to WhatsApp is never delayed. Returns a cleanup
   * function; safe to call repeatedly (handlers are attached once per element).
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
        // A failed peek must never break the page: the CTAs keep their
        // server-rendered fallback hrefs.
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
