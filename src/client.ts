/** Agent rotation for WhatsApp and phone CTAs. Runs in the browser. */

import type { Challenge } from "./challenge.js"
import { normalizeBaseUrl, request, type BaseConfig } from "./core.js"

export { LinkerestateError } from "./core.js"
export {
  mountChallenge,
  type Challenge,
  type ChallengeOptions,
  type ChallengePlacement,
} from "./challenge.js"

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
  tel: '[id^="tel-btn"], [id^="phone-btn"], [data-rr-link="tel"]',
}

export interface LeadFormAgent {
  id: string
  username: string | null
  full_name: string | null
  avatar: string | null
}

export interface RoundRobinClient {
  /** Reads the WhatsApp/phone agent on turn without consuming the slot. */
  peek(): Promise<NextAgent | null>
  /**
   * Agent on turn for the lead form — a different lane from the WhatsApp one,
   * with its own cursor, so neither spends the other's turn. Render their card
   * when a page has no agent of its own, then pass the returned
   * `leadFormAgentId` as `lead_form_agent_id` on submit, so the same person
   * receives the lead and the turn is spent.
   *
   * `agent` is null when the profile is not public: the lead still routes to
   * them, but there is no card to show.
   */
  peekLeadForm(): Promise<{ leadFormAgentId: string; agent: LeadFormAgent | null } | null>
  /**
   * Binds click handlers that commit the assignment without blocking
   * navigation. Returns a cleanup function; each element is bound once.
   */
  attachCommitHandlers(root?: ParentNode): () => void
}

export function createRoundRobinClient(config: RoundRobinConfig): RoundRobinClient {
  const base = normalizeBaseUrl(config.baseUrl)
  const endpoint = `${base}/campaigns/${config.campaignId}/rotation`

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

    async peekLeadForm() {
      try {
        const res = await request<{
          lead_form_agent_id: string
          agent: LeadFormAgent | null
        }>(endpoint, {
          query: { lane: "lead-form", key: config.apiKey },
          timeoutMs: 4500,
        })
        return { leadFormAgentId: res.lead_form_agent_id, agent: res.agent ?? null }
      } catch {
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

export interface CommitProxyOptions {
  /**
   * Your own server route that verifies the challenge token and then commits the turn — e.g.
   * `/api/rr-commit`. It receives `POST { type: "whatsapp" | "tel", token }` as JSON.
   */
  endpoint: string
  /** The challenge whose token goes with each click; see `mountChallenge`. */
  challenge: Challenge
  /** Where to look for the CTAs. Default `document`. */
  root?: ParentNode
}

/**
 * The challenged variant of `attachCommitHandlers()`: each WhatsApp / phone click posts the
 * challenge's token to YOUR route, which verifies it (`verifyChallenge` from
 * `@linkerestate/sdk/server`) before committing the turn — so a bot clicking the buttons cannot
 * spin the rotation. Same selectors, same fire-and-forget beacon, never blocks the navigation.
 * Returns a cleanup function; each element is bound once.
 */
export function attachCommitProxy(options: CommitProxyOptions): () => void {
  const root = options.root ?? document
  const cleanups: Array<() => void> = []
  for (const channel of Object.keys(SELECTORS) as CtaChannel[]) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(SELECTORS[channel]))) {
      if (el.dataset.rrCommitAttached === "true") continue
      el.dataset.rrCommitAttached = "true"
      const onClick = async () => {
        // A click right after the previous one finds the next token still on its way: wait for
        // it briefly — the CTA opens WhatsApp or the dialer, so this page is still alive.
        const token =
          options.challenge.takeToken() ??
          ((await options.challenge.waitForToken(5000)) && options.challenge.takeToken())
        const body = JSON.stringify({ type: channel, token: token ?? "" })
        const sent =
          typeof navigator.sendBeacon === "function" &&
          navigator.sendBeacon(options.endpoint, new Blob([body], { type: "application/json" }))
        if (!sent) {
          void fetch(options.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          }).catch(() => {})
        }
      }
      el.addEventListener("click", onClick)
      cleanups.push(() => {
        el.removeEventListener("click", onClick)
        delete el.dataset.rrCommitAttached
      })
    }
  }
  return () => cleanups.forEach((fn) => fn())
}
