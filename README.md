# @linkerestate/sdk

Official client for the [Linkerestate](https://app.linkerestate.com) API.

```bash
npm i @linkerestate/sdk      # or: pnpm add / yarn add / bun add
```

Zero runtime dependencies. ESM only, Node 18+ and any modern browser.

## Entry points

Each surface has its own module and its own key scope.

| Import | Key scope | Runs in |
| --- | --- | --- |
| `@linkerestate/sdk/client` | `campaign_rr` — public | browser |
| `@linkerestate/sdk/server` | `campaign_leads` — secret | server |
| `@linkerestate/sdk/catalog` | `api_v1` — secret | server |

Issue keys under **Settings → Developer** in your workspace.

## Agent rotation (browser)

Points your WhatsApp / phone CTAs at whichever agent is on turn, and records the
click. Both calls fail soft: if the API is unreachable the buttons keep the
hrefs your page rendered.

```ts
import { createRoundRobinClient } from "@linkerestate/sdk/client"

const rr = createRoundRobinClient({
  campaignId: "00000000-0000-0000-0000-000000000000",
  apiKey: "wak_rr_…",          // safe to ship to the browser
  source: "…",                 // optional: campaign source webhook_key, for attribution
})

const agent = await rr.peek()
if (agent?.waUrl) document.querySelector("#wa-btn")?.setAttribute("href", agent.waUrl)

const detach = rr.attachCommitHandlers()   // binds clicks; returns a cleanup fn
```

### Lead-form lane

A separate rotation with its own cursor — a lead never spends a WhatsApp turn,
nor the other way round. Use it when a page has no agent of its own: render the
card, then pass the id on submit so that same person receives the lead.

```ts
const turn = await rr.peekLeadForm()
// { leadFormAgentId: "…", agent: { id, username, full_name, avatar } | null }
```

`agent` is null when the profile is not public: the lead still routes to them,
but there is no card to show. Peeking spends nothing — the turn is only consumed
when the lead arrives carrying `lead_form_agent_id`.

`attachCommitHandlers()` binds to `[id^="wa-btn"], [data-rr-link="whatsapp"]` and
`[id^="tel-btn"], [data-rr-link="tel"]`, and is safe to call again after a
client-side navigation — each element is only bound once.

## Lead capture (server)

```ts
import { createLeadsClient } from "@linkerestate/sdk/server"

const leads = createLeadsClient({
  campaignId: "00000000-0000-0000-0000-000000000000",
  apiKey: process.env.LINKERESTATE_LEADS_KEY!,   // never expose this
  webhookKey: process.env.LINKERESTATE_WEBHOOK_KEY!,
})

const { assigned_to } = await leads.submit({
  first_name: "Ana",
  phone: "+18095551234",
  email: "ana@example.com",
  // Optional: the agent whose card the page rendered, from peekLeadForm().
  // Spends that rotation turn, so the next visitor sees the following agent.
  lead_form_agent_id: turn?.leadFormAgentId,
})
```

A lead needs at least one of `first_name`, `last_name`, `phone`, `email`.

## Phone verification (WhatsApp code)

Since 1.6.0. For workspaces that have the feature, a lead form can prove the
visitor owns the WhatsApp number they typed before the lead is submitted: the
platform sends a code through a WhatsApp authentication template from the
workspace's own number, the visitor types it, and only then is the lead
submitted. Same client, same `campaign_leads` key — the browser never talks to
the platform, your server does.

```ts
leads.startPhoneVerification({ phone, language?: "es" | "en" })
// → { required: false, reason }                                    submit directly
// → { required: true, verification_id, expires_at, resend_available_at, code_length }

leads.checkPhoneVerification(verificationId, code)
// → { verified: true, verification_id }                            then submit with it

leads.submit({ ...lead, phone_verification_id: verification_id })
```

### The fail-open rule — never lose a lead to this feature

Submit the lead **directly, without verification**, when `startPhoneVerification`

- answers `{ required: false }` — `reason` is `module_disabled`, `inactive`,
  `not_configured` or `send_failed`; or
- throws anything that is **not** a `LinkerestateError` with status 422 or 429 —
  a network error, a timeout, a 5xx. `phoneVerificationFailsOpen(err)` answers
  exactly this.

Only a 422 (`no_whatsapp`, `invalid_phone`) or a 429 (`too_many_codes`) stops the
form, because those are the visitor's to fix. `no_whatsapp` means the number has
no WhatsApp: show it and do not submit.

### Refusals

Every refusal is a `LinkerestateError` whose `code` names it.
`isPhoneVerificationError(err, code?)` narrows it and types `err.body`:

| `code` | Status | From | Meaning |
| --- | --- | --- | --- |
| `no_whatsapp` | 422 | start | the number has no WhatsApp — do not submit |
| `invalid_phone` | 422 | start | not E.164 |
| `too_many_codes` | 429 | start | 30 s between sends, 5 per hour; `body.retry_after` (seconds) |
| `invalid_code` | 422 | check | wrong code; `body.attempts_left` |
| `expired` | 410 | check | the code's 10 minutes ran out — start again |
| `too_many_attempts` | 429 | check | 5 wrong codes — start again |
| `not_found` | 404 | check | unknown id, or another campaign's |
| `phone_verification_invalid` | 422 | submit | the id is not a verified, unconsumed verification of this phone from the last 30 minutes |
| `code_not_sent` | 422 | start | WhatsApp could not deliver the code and the workspace does not accept unverified leads — do not submit; let the visitor try again |

Whether a code WhatsApp could not deliver lets the form through is the **workspace's** choice
(Settings › Campañas › Verificación de WhatsApp, «Enviar el formulario si el código no llega», on
by default). On, `startPhoneVerification` answers `{ required: false, reason: "send_failed" }` and
the site submits as usual; off, it throws `code_not_sent`.

`phone_verification_id` must be submitted with the **same phone** that was
verified (digits compared), and it is consumed by the lead it is submitted with.
A resend is another `startPhoneVerification` call, after `resend_available_at`.
If the resend does NOT pass your anti-bot check again (a Turnstile token is
single-use), pass the previous id as `resendOf`: the API only honours a resend
that continues a verification of the same campaign and phone from the last hour,
and answers 404 `not_found` otherwise — so a made-up id cannot send your paid
WhatsApp codes to arbitrary numbers. Send the visitor back to the form then.

### Astro Action, end to end

The form posts twice: once with the contact details (step 1), and — only if a
code was sent — again with the code (step 2). The step-1 fields travel back with
step 2, so the lead can be submitted from there.

```ts
// src/actions/index.ts
import { ActionError, defineAction } from "astro:actions"
import { z } from "astro:schema"
import {
  createLeadsClient,
  isPhoneVerificationError,
  phoneVerificationFailsOpen,
  type LeadPayload,
} from "@linkerestate/sdk/server"

// process.env, read at RUNTIME: import.meta.env would be folded at build time.
const leads = createLeadsClient({
  campaignId: process.env.LINKERESTATE_CAMPAIGN_ID!,
  apiKey: process.env.LINKERESTATE_LEADS_KEY!,
  webhookKey: process.env.LINKERESTATE_WEBHOOK_KEY!,
})

const contact = {
  first_name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().min(7),
  lead_form_agent_id: z.string().optional(),
}

function payload(input: { first_name: string; email?: string; phone: string; lead_form_agent_id?: string }): LeadPayload {
  return { ...input, source: "website", channel: "contact_form" }
}

export const server = {
  // Step 1 — also the "resend code" button: it just starts again.
  requestLead: defineAction({
    accept: "form",
    input: z.object({ ...contact, "cf-turnstile-response": z.string() }),
    handler: async (input) => {
      const { "cf-turnstile-response": token, ...lead } = input
      if (!(await verifyTurnstile(token))) {
        throw new ActionError({ code: "FORBIDDEN", message: "Verificación anti-bot fallida." })
      }

      try {
        const start = await leads.startPhoneVerification({ phone: lead.phone, language: "es" })
        if (start.required) {
          return {
            verification_required: true as const,
            verification_id: start.verification_id,
            resend_available_at: start.resend_available_at,
            code_length: start.code_length,
          }
        }
        // required: false — the workspace does not verify (or the send failed): fall through.
      } catch (err) {
        if (isPhoneVerificationError(err, "no_whatsapp")) {
          throw new ActionError({ code: "BAD_REQUEST", message: "Ese número no tiene WhatsApp." })
        }
        if (isPhoneVerificationError(err, "invalid_phone")) {
          throw new ActionError({ code: "BAD_REQUEST", message: "Revisa el número de teléfono." })
        }
        if (isPhoneVerificationError(err, "too_many_codes")) {
          throw new ActionError({
            code: "TOO_MANY_REQUESTS",
            message: `Espera ${err.body.retry_after ?? 30} s para pedir otro código.`,
          })
        }
        if (!phoneVerificationFailsOpen(err)) throw err
        // Network error, timeout, 5xx: fail open and submit below.
        console.error("[phone-verification] start failed, submitting unverified", err)
      }

      await leads.submit(payload(lead))
      return { verification_required: false as const }
    },
  }),

  // Step 2 — the code the visitor typed, plus the same contact fields.
  confirmLead: defineAction({
    accept: "form",
    input: z.object({ ...contact, verification_id: z.string(), code: z.string() }),
    handler: async ({ verification_id, code, ...lead }) => {
      try {
        const check = await leads.checkPhoneVerification(verification_id, code)
        await leads.submit({ ...payload(lead), phone_verification_id: check.verification_id })
        return { ok: true as const }
      } catch (err) {
        if (isPhoneVerificationError(err, "invalid_code")) {
          throw new ActionError({
            code: "BAD_REQUEST",
            message: `Código incorrecto. Te quedan ${err.body.attempts_left ?? 0} intentos.`,
          })
        }
        if (isPhoneVerificationError(err, "expired") || isPhoneVerificationError(err, "too_many_attempts")) {
          throw new ActionError({ code: "BAD_REQUEST", message: "El código ya no es válido. Pide uno nuevo." })
        }
        throw err
      }
    },
  }),
}

// Your own Cloudflare Turnstile server-side check (siteverify).
declare function verifyTurnstile(token: string): Promise<boolean>
```

On the page: call `requestLead`; if it answers `verification_required`, show a
code input of `code_length` digits, keep `verification_id`, enable «Reenviar
código» from `resend_available_at` (it calls `requestLead` again with a fresh
Turnstile token and replaces the id — or, without a fresh token, an action that
calls `startPhoneVerification({ phone, resendOf: verification_id })`), and send
the code with `confirmLead`. Either path that ends in a
submitted lead fires the conversion event and the redirect, as before.

In local development (`LEAD_PHONE_VERIFICATION_DEV_SINK=true` on the platform's
local stack) the code is not sent to WhatsApp but to Mailpit, so the whole flow
can be walked against `baseUrl` pointed at the local functions.

## Catalog (server)

```ts
import { createCatalogClient } from "@linkerestate/sdk/catalog"

const catalog = createCatalogClient({ apiKey: process.env.LINKERESTATE_API_KEY! })

const { data, meta } = await catalog.properties({ page: 1, listing_type: "sale" })

// `page_size` is honoured up to 100 and reported back in `meta.page_size`. Omit
// it for the endpoint's own default of 10 (25 for agents). Ask for it when you
// need the whole filtered set: walking a large catalogue ten rows at a time is
// many requests where one or two would do, and every one of them is spent
// against this surface's rate-limit budget.
const wide = await catalog.properties({ page: 1, page_size: 100 })

// One property by UUID, numeric public id, or slug
const { data: property } = await catalog.property("torre-central")

// Ranked by sales instead of by name. Amounts are never exposed — only the
// ordering. Heavier than the default: this path pages in memory.
const ranked = await catalog.agents({ sort: "sales" })
// `meta.total_active` counts the workspace's ACTIVE advisors, published profile
// or not — unlike `meta.total`, which counts what this response returns and so
// only the public ones. Use it for a headcount; use `total` to paginate.

if (ranked.meta.sort_fallback) {
  // The ranking query failed and the list came back shuffled — deliberately
  // not alphabetical, which would always favour names starting with "A".
  // Don't present it as ranked.
}

// One agent by UUID or username. Public URLs carry the username, never the id.
const { data: agent } = await catalog.agent("maria-perez")

// Append-only popularity event. Un-favouriting does not decrement, so there is
// no counterpart call.
await catalog.favorite(property.id, { visitorId })
```

An agent whose profile stopped being public answers 404 exactly like one who
never existed, so a lookup used as a fallback should read a `LinkerestateError`
with `status: 404` as "no agent" rather than as a failure.

### Caching

Every request goes out `no-store` by default. That is right for a rotation and
wrong for a catalog: under Next.js it opts the whole page out of static
rendering. Pass `fetchOptions` to put the catalog back on ISR — client-wide, or
per call when one endpoint wants a different window:

```ts
const catalog = createCatalogClient({
  apiKey: process.env.LINKERESTATE_API_KEY!,
  fetchOptions: { cache: "force-cache", next: { revalidate: 600 } },
})

// This one list tolerates a much longer window than the rest.
const counts = await catalog.properties({ page: 1 }, {
  fetchOptions: { next: { revalidate: 1800 } },
})
```

`headers`, `body` and `signal` are not overridable — the first two describe the
request and the third enforces the SDK's timeout.

Property and agent objects are returned as-is from the API and typed as open
records.

## Errors

Every non-2xx response throws a `LinkerestateError` carrying `status`, the
parsed `body` and, when the body names one, a machine-readable `code` (since
1.6.0; e.g. `"invalid_code"`) — except `peek()`, which returns `null` instead so a rotation
outage can never break a page.

```ts
import { LinkerestateError } from "@linkerestate/sdk/server"

try {
  await leads.submit({ email: "ana@example.com" })
} catch (err) {
  if (err instanceof LinkerestateError && err.status === 401) {
    // revoked key, or a key issued for a different workspace
  }
}
```

## Pointing at another environment

`baseUrl` overrides the API root. Leave it unset unless you are pointing at a
non-production environment. The default is
`https://api.linkerestate.com/functions/v1/public-api/v1`; staging is
`https://bijrjgviuwdusrqelbtw.supabase.co/functions/v1/public-api/v1`.

Versions before 1.5.0 default to `https://app.linkerestate.com/api/v1`, which keeps
working only until the app host's temporary rewrite is removed — upgrade before then.

```ts
createCatalogClient({ apiKey, baseUrl: process.env.LINKERESTATE_API_URL })
```

## License

MIT
