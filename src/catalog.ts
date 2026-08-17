/** Property and agent catalog. Server-side only. */

import { normalizeBaseUrl, request, type BaseConfig, type Meta, type Paginated } from "./core.js"

export { LinkerestateError } from "./core.js"

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

/** Filters accepted by the properties endpoint. Comma-joined where plural. */
export interface PropertyQuery {
  page?: number
  listing_type?: string
  property_status?: string[]
  offer_types?: string[]
  property_type_id?: string[]
  property_type_key?: string[]
  city_id?: number[]
  state_id?: number[]
  sector_id?: number[]
  organization_id?: string
}

export interface AgentQuery {
  page?: number
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
  properties(query?: PropertyQuery): Promise<Paginated<Property>>
  /** One property by UUID, numeric public id, or slug. */
  property(idOrSlug: string): Promise<{ data: Property }>
  agents(query?: AgentQuery): Promise<Paginated<Agent, AgentsMeta>>
  /**
   * One agent by UUID or username. Public URLs carry the username, never the
   * raw id, so both forms resolve here.
   *
   * Visibility can flip at any moment, so an agent who is no longer public
   * answers 404 like one who never existed. Callers that use this as a
   * fallback lookup should treat the `LinkerestateError` with `status: 404`
   * as "no agent", not as a failure.
   */
  agent(idOrUsername: string): Promise<{ data: Agent }>
}

function toQuery(query: object = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    out[k] = Array.isArray(v) ? v.join(",") : String(v)
  }
  return out
}

export function createCatalogClient(config: CatalogConfig): CatalogClient {
  const base = normalizeBaseUrl(config.baseUrl)

  return {
    properties(query = {}) {
      return request<Paginated<Property>>(`${base}/properties`, {
        bearer: config.apiKey,
        query: toQuery(query),
      })
    },
    property(idOrSlug: string) {
      return request<{ data: Property }>(
        `${base}/properties/${encodeURIComponent(idOrSlug)}`,
        { bearer: config.apiKey }
      )
    },
    agents(query = {}) {
      return request<Paginated<Agent, AgentsMeta>>(`${base}/agents`, {
        bearer: config.apiKey,
        query: toQuery(query),
      })
    },
    agent(idOrUsername: string) {
      return request<{ data: Agent }>(
        `${base}/agents/${encodeURIComponent(idOrUsername)}`,
        { bearer: config.apiKey }
      )
    },
  }
}
