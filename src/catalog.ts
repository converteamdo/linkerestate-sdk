/** Property and agent catalog. Server-side only. */

import { normalizeBaseUrl, request, type BaseConfig } from "./core.js"

export { LinkerestateError } from "./core.js"

export interface CatalogConfig extends BaseConfig {
  /** An `api_v1` key with read permission. Server-only. */
  apiKey: string
}

export interface Pagination {
  page: number
  page_size: number
  total: number
  total_pages: number
}

export interface Paginated<T> {
  data: T[]
  pagination: Pagination
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

export interface CatalogClient {
  properties(query?: PropertyQuery): Promise<Paginated<Property>>
  agents(query?: { page?: number }): Promise<Paginated<Agent>>
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
    agents(query = {}) {
      return request<Paginated<Agent>>(`${base}/agents`, {
        bearer: config.apiKey,
        query: toQuery(query),
      })
    },
  }
}
