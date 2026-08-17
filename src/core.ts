/** Shared request helpers for every surface of the Linkerestate API. */

export const DEFAULT_BASE_URL = "https://app.linkerestate.com/api/v1"

export interface BaseConfig {
  /** Override the API root. Leave unset to use the default. */
  baseUrl?: string
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
}

/** Performs a request and throws `LinkerestateError` on any non-2xx response. */
export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", bearer, query, body, timeoutMs = 8000, signal } = opts

  const target = new URL(url)
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) target.searchParams.set(k, v)
  }

  const headers: Record<string, string> = {}
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (body !== undefined) headers["Content-Type"] = "application/json"

  const res = await fetch(target.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
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
