/** Property and agent catalog. Server-side only. */

import {
  normalizeBaseUrl,
  request,
  type BaseConfig,
  type FetchOverrides,
  type Meta,
  type Paginated,
} from "./core.js"

export { LinkerestateError } from "./core.js"
export type { FetchOverrides } from "./core.js"

/**
 * Per-call caching policy. Merged over whatever `fetchOptions` the client was
 * created with, so a client can set one default window and a single endpoint
 * can still ask for another.
 */
export interface CallOptions {
  fetchOptions?: FetchOverrides
}

export interface CatalogConfig extends BaseConfig {
  /** An `api_v1` key with read permission. Server-only. */
  apiKey: string
}

export type { Meta, Paginated } from "./core.js"

/** `/agents` adds a flag to the standard meta block. */
export interface AgentsMeta extends Meta {
  /**
   * True when `sort: "sales"` was requested but the ranking query failed. The
   * response is then in random order — deliberately not alphabetical, which
   * would systematically favour agents whose name starts with "A". Read this
   * before presenting the list as ranked.
   */
  sort_fallback: boolean
}

export type Property = { id: string } & Record<string, unknown>
export type Agent = { id: string } & Record<string, unknown>

/**
 * Filters accepted by the properties endpoint. Arrays are comma-joined; the
 * boolean flags are sent as `1` when true and omitted when false, which is how
 * the API reads them.
 *
 * Location can be given by id or by name, and the two are independent filters
 * rather than aliases — `city_id` matches the catalog id, `city` matches the
 * stored name.
 */
export interface PropertyQuery {
  page?: number
  /**
   * Rows per page, capped server-side at 100. Omit it to get the endpoint's own
   * default of 10 — the size every consumer written before this existed relies
   * on. Ask for it when you need the whole filtered set: walking a large
   * catalogue ten rows at a time is many requests where one or two would do,
   * and each of them is spent against the surface's rate-limit budget.
   */
  page_size?: number
  /** Free-text search. */
  search?: string
  listing_type?: string
  property_status?: string[]
  offer_types?: string[]
  property_type_id?: string[]
  property_type_key?: string[]
  city_id?: number[]
  city?: string[]
  state_id?: number[]
  province?: string[]
  sector_id?: number[]
  sector?: string[]
  amenities?: string[]
  tags?: string[]
  organization_id?: string
  furnishing?: string
  floors?: number
  min_price?: number
  max_price?: number
  min_rooms?: number
  min_bathrooms?: number
  min_parking?: number
  featured?: boolean
  confotur?: boolean
  /** "Bono Primera Vivienda" — sent as `first_home_bonus=1`. */
  first_home_bonus?: boolean
  safe?: boolean
  delivery_date_from?: string
  delivery_date_to?: string
  /** e.g. `"views"`, `"priority"`, `"price"`, `"name"`, `"favorites"`. */
  sort_field?: string
  /** Descending unless this is `"asc"`. */
  sort_dir?: "asc" | "desc"
}

export interface AgentQuery {
  page?: number
  /** Rows per page, capped server-side at 100. Omit for the endpoint's default of 25. */
  page_size?: number
  /** Free-text search over the agent's name. */
  q?: string
  /**
   * `"sales"` orders by sales ranking instead of name. Amounts are never
   * exposed — only the ordering. Note this path fetches every matching agent
   * and paginates in memory, so it is heavier than the default order.
   */
  sort?: "sales"
}

export interface CatalogClient {
  properties(query?: PropertyQuery, options?: CallOptions): Promise<Paginated<Property>>
  /** One property by UUID, numeric public id, or slug. */
  property(idOrSlug: string, options?: CallOptions): Promise<{ data: Property }>
  agents(query?: AgentQuery, options?: CallOptions): Promise<Paginated<Agent, AgentsMeta>>
  /**
   * One agent by UUID or username. Public URLs carry the username, never the
   * raw id, so both forms resolve here.
   *
   * Visibility can flip at any moment, so an agent who is no longer public
   * answers 404 like one who never existed. Callers that use this as a
   * fallback lookup should treat the `LinkerestateError` with `status: 404`
   * as "no agent", not as a failure.
   */
  agent(idOrUsername: string, options?: CallOptions): Promise<{ data: Agent }>
  /**
   * Records a favourite — an append-only popularity event that feeds the
   * "most favourited" ordering. Un-favouriting does not decrement, so there is
   * nothing to undo and no call to make for it.
   *
   * `visitorId` is a stable anonymous browser id, sent as `x-visitor-id`, and
   * is what keeps one visitor from inflating the count.
   */
  favorite(uid: string, options?: CallOptions & { visitorId?: string }): Promise<void>
}

function toQuery(query: object = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      out[k] = v.join(",")
    } else if (typeof v === "boolean") {
      // The API reads these as the literal "1"; sending "false" would enable
      // the filter rather than clear it.
      if (v) out[k] = "1"
    } else {
      out[k] = String(v)
    }
  }
  return out
}

export function createCatalogClient(config: CatalogConfig): CatalogClient {
  const base = normalizeBaseUrl(config.baseUrl)

  /** Per-call policy wins over the client-wide one. */
  function fetchOptions(options?: CallOptions): FetchOverrides | undefined {
    if (!config.fetchOptions && !options?.fetchOptions) return undefined
    return { ...config.fetchOptions, ...options?.fetchOptions }
  }

  return {
    properties(query = {}, options) {
      return request<Paginated<Property>>(`${base}/properties`, {
        bearer: config.apiKey,
        query: toQuery(query),
        fetchOptions: fetchOptions(options),
      })
    },
    property(idOrSlug: string, options) {
      return request<{ data: Property }>(
        `${base}/properties/${encodeURIComponent(idOrSlug)}`,
        { bearer: config.apiKey, fetchOptions: fetchOptions(options) }
      )
    },
    agents(query = {}, options) {
      return request<Paginated<Agent, AgentsMeta>>(`${base}/agents`, {
        bearer: config.apiKey,
        query: toQuery(query),
        fetchOptions: fetchOptions(options),
      })
    },
    agent(idOrUsername: string, options) {
      return request<{ data: Agent }>(
        `${base}/agents/${encodeURIComponent(idOrUsername)}`,
        { bearer: config.apiKey, fetchOptions: fetchOptions(options) }
      )
    },
    async favorite(uid: string, options) {
      const merged = fetchOptions(options)
      const visitor = options?.visitorId
      await request<unknown>(`${base}/properties/${encodeURIComponent(uid)}/favorite`, {
        method: "POST",
        bearer: config.apiKey,
        timeoutMs: 6000,
        fetchOptions: visitor
          ? { ...merged, headers: { ...merged?.headers, "x-visitor-id": visitor } }
          : merged,
      })
    },
  }
}
