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

Every non-2xx response throws a `LinkerestateError` carrying `status` and the
parsed `body` — except `peek()`, which returns `null` instead so a rotation
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
