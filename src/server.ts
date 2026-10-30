/** Lead submission and phone verification. Server-side only. */

import { LinkerestateError, normalizeBaseUrl, request, type BaseConfig } from "./core.js"

export { LinkerestateError } from "./core.js"

export interface LeadsConfig extends BaseConfig {
  /** Campaign UUID the lead belongs to. */
  campaignId: string
  /** A `campaign_leads` key. Server-only — never ship it to a client bundle. */
  apiKey: string
  /** Campaign source `webhook_key`, identifying which form the lead came from. */
  webhookKey: string
}

export interface LeadPayload {
  /**
   * Agent the page already rendered, from `peekLeadForm()`. Unlike
   * `sale_agent_id` this one spends that rotation turn, so the next visitor
   * sees the following agent.
   */
  lead_form_agent_id?: string
  first_name?: string
  last_name?: string
  phone?: string
  email?: string
  /** Routes the lead straight to this agent instead of the rotation. */
  sale_agent_id?: string
  source?: string
  channel?: string
  notes?: string
  country?: string
  /** IANA timezone, e.g. "America/Santo_Domingo". */
  timezone?: string
  language?: string
  campaign_name?: string
  form_name?: string
  ad_id?: string
  adset_id?: string
  ad_name?: string
  adset_name?: string
  /**
   * The `verification_id` a successful {@link LeadsClient.checkPhoneVerification} returned. It
   * must name a verification of this campaign that is verified, not yet consumed, verified less
   * than 30 minutes ago, and whose phone equals this lead's `phone` (digits compared); otherwise
   * the submit is refused with `422 { code: "phone_verification_invalid" }`. On success the lead
   * is stored as phone-verified and the verification is consumed (it cannot be reused).
   *
   * Leave it out when the visitor was not verified — including every fail-open case (see
   * {@link LeadsClient.startPhoneVerification}): absent means exactly the pre-1.6.0 behaviour.
   */
  phone_verification_id?: string
}

export interface LeadResult {
  ok: true
  assigned_to: string
  submission_id: string
}

/**
 * Why no code was sent, so the site should submit the lead directly:
 * - `module_disabled` — the workspace does not have the feature;
 * - `inactive` — the workspace has it but switched it off;
 * - `not_configured` — no sending number or no approved template yet;
 * - `send_failed` — Meta refused the send for a reason that is not the visitor's number.
 */
export type PhoneVerificationSkipReason =
  | "module_disabled"
  | "inactive"
  | "not_configured"
  | "send_failed"

export type PhoneVerificationStart =
  | { required: false; reason: PhoneVerificationSkipReason }
  | {
      required: true
      /** Pass to `checkPhoneVerification`, then to `submit` as `phone_verification_id`. */
      verification_id: string
      /** ISO timestamp; the code is valid 10 minutes. */
      expires_at: string
      /** ISO timestamp before which a resend answers `429 too_many_codes`. */
      resend_available_at: string
      /** Digits in the code (6 today) — size the input from this, not from a constant. */
      code_length: number
    }

export interface PhoneVerificationCheck {
  verified: true
  verification_id: string
}

/**
 * The `code` of every refusal the two verification calls (and a submit carrying
 * `phone_verification_id`) can answer:
 *
 * | code | status | from | meaning |
 * | --- | --- | --- | --- |
 * | `no_whatsapp` | 422 | start | the number has no WhatsApp — show it, do NOT submit |
 * | `invalid_phone` | 422 | start | not E.164 |
 * | `too_many_codes` | 429 | start | resend too soon / 5 per hour; `body.retry_after` (seconds) |
 * | `invalid_code` | 422 | check | wrong code; `body.attempts_left` |
 * | `expired` | 410 | check | past `expires_at` — start again |
 * | `too_many_attempts` | 429 | check | 5 wrong codes — start again |
 * | `not_found` | 404 | check | unknown id, or another campaign's |
 * | `phone_verification_invalid` | 422 | submit | the id is not a usable verification of this phone |
 * | `code_not_sent` | 422 | start | WhatsApp could not deliver the code and the workspace chose not to accept unverified leads — do not submit; offer to try again |
 */
export type PhoneVerificationErrorCode =
  | "no_whatsapp"
  | "invalid_phone"
  | "too_many_codes"
  | "invalid_code"
  | "expired"
  | "too_many_attempts"
  | "not_found"
  | "phone_verification_invalid"
  | "code_not_sent"

/** The parsed body of a phone-verification refusal. */
export interface PhoneVerificationErrorBody {
  /** Human-readable, in English — not for display to the visitor. */
  error: string
  code: PhoneVerificationErrorCode
  /** Present on `invalid_code`: wrong codes still allowed before `too_many_attempts`. */
  attempts_left?: number
  /** Present on `too_many_codes`: seconds until another code may be requested. */
  retry_after?: number
}

/** A `LinkerestateError` known to be a phone-verification refusal, with its body typed. */
export type PhoneVerificationError<C extends PhoneVerificationErrorCode = PhoneVerificationErrorCode> =
  LinkerestateError & { readonly code: C; readonly body: PhoneVerificationErrorBody & { code: C } }

const PHONE_VERIFICATION_CODES: ReadonlySet<string> = new Set<PhoneVerificationErrorCode>([
  "no_whatsapp",
  "invalid_phone",
  "too_many_codes",
  "invalid_code",
  "expired",
  "too_many_attempts",
  "not_found",
  "phone_verification_invalid",
  "code_not_sent",
])

/**
 * Narrows `err` to a phone-verification refusal — any of them, or the one `code` given — so its
 * `body.attempts_left` / `body.retry_after` are typed:
 *
 * ```ts
 * if (isPhoneVerificationError(e, "invalid_code")) return { attemptsLeft: e.body.attempts_left }
 * ```
 */
export function isPhoneVerificationError<C extends PhoneVerificationErrorCode = PhoneVerificationErrorCode>(
  err: unknown,
  code?: C
): err is PhoneVerificationError<C> {
  if (!(err instanceof LinkerestateError) || err.code === undefined) return false
  return code === undefined ? PHONE_VERIFICATION_CODES.has(err.code) : err.code === code
}

/**
 * The FAIL-OPEN rule as a predicate: `true` when an error thrown by `startPhoneVerification`
 * means "submit the lead without verification" — anything that is NOT a `LinkerestateError` with
 * status 422 or 429 (network error, timeout, 5xx, …). `false` for a 422/429, which is the
 * visitor's to act on (`no_whatsapp`, `invalid_phone`, `too_many_codes`).
 */
export function phoneVerificationFailsOpen(err: unknown): boolean {
  return !(err instanceof LinkerestateError && (err.status === 422 || err.status === 429))
}

const E164 = /^\+[1-9]\d{6,14}$/

export interface LeadsClient {
  /** Submits a lead and returns the agent it was assigned to. */
  submit(payload: LeadPayload): Promise<LeadResult>

  /**
   * Step 1 of the WhatsApp phone verification: asks the platform to send a code to `phone` from
   * the workspace's own WhatsApp number. Each call sends a new code. A RESEND passes the previous
   * `verification_id` as `resendOf` (after `resend_available_at`): a resend normally skips the
   * site's anti-bot check, so the API only honours one that continues a verification of the same
   * campaign and phone from the last hour, and answers 404 `not_found` otherwise — send the visitor
   * back to the form (and its anti-bot check) when it does. A FIRST call never takes `resendOf`
   * and must sit behind that check.
   *
   * **FAIL-OPEN — never lose a lead to this feature.** Submit the lead directly, without
   * `phone_verification_id`, when this either
   * - answers `{ required: false }` (the workspace does not use the feature, or the send failed), or
   * - throws anything that is NOT a `LinkerestateError` with status 422/429 — a network error, a
   *   timeout, a 5xx ({@link phoneVerificationFailsOpen} answers exactly this).
   *
   * Only a 422 (`no_whatsapp`, `invalid_phone`) or a 429 (`too_many_codes`) stops the form: show
   * it to the visitor.
   *
   * `phone` must be E.164 (`+18095551234`); spaces, parentheses and dashes are stripped first.
   * Waits on Meta, so its timeout is 10 s.
   *
   * @throws TypeError when `phone` is not E.164 after stripping.
   */
  startPhoneVerification(input: {
    phone: string
    language?: "es" | "en"
    resendOf?: string
  }): Promise<PhoneVerificationStart>

  /**
   * Step 2: checks the code the visitor typed. On `{ verified: true }` submit the lead with
   * `phone_verification_id: verification_id` and the SAME phone. Refusals throw a
   * `LinkerestateError` — `invalid_code` (422, `attempts_left`), `expired` (410),
   * `too_many_attempts` (429), `not_found` (404); read them with {@link isPhoneVerificationError}.
   *
   * @throws TypeError when `verificationId` is empty or `code` is not digits.
   */
  checkPhoneVerification(verificationId: string, code: string): Promise<PhoneVerificationCheck>
}

export function createLeadsClient(config: LeadsConfig): LeadsClient {
  const base = normalizeBaseUrl(config.baseUrl)
  const campaignBase = `${base}/campaigns/${config.campaignId}`

  return {
    submit(payload: LeadPayload) {
      if (!payload.first_name && !payload.last_name && !payload.phone && !payload.email) {
        throw new TypeError("A lead needs at least one of: first_name, last_name, phone, email")
      }
      return request<LeadResult>(`${campaignBase}/leads`, {
        method: "POST",
        bearer: config.apiKey,
        body: { webhook_key: config.webhookKey, ...payload },
        timeoutMs: 8000,
      })
    },

    startPhoneVerification({ phone, language, resendOf }) {
      const normalized = (phone ?? "").replace(/[\s()-]/g, "")
      if (!E164.test(normalized)) {
        throw new TypeError(`phone must be E.164 (e.g. +18095551234), got "${phone}"`)
      }
      return request<PhoneVerificationStart>(`${campaignBase}/phone-verifications`, {
        method: "POST",
        bearer: config.apiKey,
        body: { webhook_key: config.webhookKey, phone: normalized, language, resend_of: resendOf },
        timeoutMs: 10000,
      })
    },

    checkPhoneVerification(verificationId: string, code: string) {
      if (!verificationId) throw new TypeError("verificationId is required")
      const digits = (code ?? "").trim()
      if (!/^\d+$/.test(digits)) throw new TypeError("code must be a non-empty string of digits")
      return request<PhoneVerificationCheck>(
        `${campaignBase}/phone-verifications/${encodeURIComponent(verificationId)}/check`,
        {
          method: "POST",
          bearer: config.apiKey,
          body: { code: digits },
          timeoutMs: 8000,
        }
      )
    },
  }
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

export interface ChallengeVerification {
  /** True only when Cloudflare confirmed the token. */
  success: boolean
  /**
   * Cloudflare's `error-codes` (`"timeout-or-duplicate"`, `"invalid-input-response"`, …), or
   * `"missing-input-response"` for an empty token and `"siteverify-unreachable"` when Cloudflare
   * did not answer. For your logs — never shown to the visitor.
   */
  errorCodes: string[]
}

export interface VerifyChallengeOptions {
  /** The Turnstile SECRET key. Server-only — never ship it to a client bundle. */
  secret: string
  /** The visitor's IP, when your framework exposes it. Optional; Cloudflare checks it against the token. */
  remoteIp?: string | null
  /** Default 6000. */
  timeoutMs?: number
}

/**
 * Verifies a Turnstile token from `mountChallenge` (`@linkerestate/sdk/client`) against
 * Cloudflare. Never throws: an empty token, a refusal, a timeout and a network failure all
 * answer `success: false`, with the reason in `errorCodes`. A token is single-use, so a second
 * verification of the same one fails with `timeout-or-duplicate`.
 */
export async function verifyChallenge(
  token: string | null | undefined,
  options: VerifyChallengeOptions
): Promise<ChallengeVerification> {
  if (!options.secret) throw new TypeError("verifyChallenge: secret is required")
  if (!token) return { success: false, errorCodes: ["missing-input-response"] }

  const body = new URLSearchParams({ secret: options.secret, response: token })
  if (options.remoteIp) body.set("remoteip", options.remoteIp)
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    })
    if (!res.ok) return { success: false, errorCodes: [`siteverify-http-${res.status}`] }
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] }
    return { success: data.success === true, errorCodes: data["error-codes"] ?? [] }
  } catch {
    return { success: false, errorCodes: ["siteverify-unreachable"] }
  }
}
