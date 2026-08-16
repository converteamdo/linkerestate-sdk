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
})
```

A lead needs at least one of `first_name`, `last_name`, `phone`, `email`.

## Catalog (server)

```ts
import { createCatalogClient } from "@linkerestate/sdk/catalog"

const catalog = createCatalogClient({ apiKey: process.env.LINKERESTATE_API_KEY! })

const { data, pagination } = await catalog.properties({ page: 1, listing_type: "sale" })
const agents = await catalog.agents()
```

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
non-production environment.

```ts
createCatalogClient({ apiKey, baseUrl: process.env.LINKERESTATE_API_URL })
```

## License

MIT
