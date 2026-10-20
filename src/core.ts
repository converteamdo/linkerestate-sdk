/** Shared request helpers for every surface of the Linkerestate API. */

/**
 * The API root: the `public-api` Edge Function on Linkerestate's API domain. Every surface builds
 * `{base}/campaigns/{id}/…`, `{base}/properties`, `{base}/agents` on it.
 *
 * Until 1.5.0 this was `https://app.linkerestate.com/api/v1`, the retired Next.js app. That path
 * still answers through a TEMPORARY rewrite on the app host, with a cutoff date — upgrade before it.
 */
export const DEFAULT_BASE_URL = "https://api.linkerestate.com/functions/v1/public-api/v1"

/**
 * Extra options merged into every `fetch` this client performs, so a host
 * framework can apply its own caching policy.
 *
 * The SDK requests `cache: "no-store"` by default, which is right for a
 * rotation but wrong for a catalog: under Next.js that opts every page out of
 * static rendering. Passing `{ cache: "force-cache", next: { revalidate: 600 } }`
 * puts the catalog back on ISR. Anything set here wins over the SDK's defaults;
 * `signal` is the one exception, since the SDK owns the request timeout.
 *
 * Typed loosely on purpose: `next` is not part of the standard `RequestInit`.
 * Give `headers` as a plain object — a `Headers` instance or an array of pairs
 * survives the type but not the merge, and its entries would be dropped.
 */
export type FetchOverrides = RequestInit & Record<string, unknown>

export interface BaseConfig {
  /** Override the API root. Leave unset to use the default. */
  baseUrl?: string
  /** Merged into every `fetch`; see {@link FetchOverrides}. */
  fetchOptions?: FetchOverrides
}

export class LinkerestateError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message)
    this.name = "LinkerestateError"
  }
}

/** Trims a trailing slash so `${base}/path` never produces a double slash. */
export function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
}

/** Wrapper every list endpoint returns. */
export interface Meta {
  page: number
  page_size: number
  total: number
  total_pages: number
}

export interface Paginated<T, M extends Meta = Meta> {
  data: T[]
  meta: M
}

export interface RequestOptions {
  method?: "GET" | "POST"
  /** Sent as `Authorization: Bearer`. */
  bearer?: string
  query?: Record<string, string | undefined>
  body?: unknown
  /** Milliseconds before the request is aborted. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Merged into the `fetch` call; see {@link FetchOverrides}. */
  fetchOptions?: FetchOverrides
}

/** Performs a request and throws `LinkerestateError` on any non-2xx response. */
export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", bearer, query, body, timeoutMs = 8000, signal, fetchOptions } = opts

  const target = new URL(url)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) target.searchParams.set(k, v)
  }

  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const res = await fetch(target.toString(), {
    method,
    cache: "no-store",
    ...fetchOptions,
    // Headers and body describe the request itself, and the signal enforces the
    // timeout — none of the three is the host framework's to override.
    headers: { ...headers, ...(fetchOptions?.headers as Record<string, string> | undefined) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    let parsed: unknown
    const text = await res.text().catch(() => "")
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    const detail =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText
    throw new LinkerestateError(`Linkerestate API ${res.status}: ${detail}`, res.status, parsed)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
