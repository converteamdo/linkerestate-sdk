/** Lead submission. Server-side only. */

import { normalizeBaseUrl, request, type BaseConfig } from "./core.js"

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
}

export interface LeadResult {
  ok: true
  assigned_to: string
  submission_id: string
}

export interface LeadsClient {
  /** Submits a lead and returns the agent it was assigned to. */
  submit(payload: LeadPayload): Promise<LeadResult>
}

export function createLeadsClient(config: LeadsConfig): LeadsClient {
  const base = normalizeBaseUrl(config.baseUrl)

  return {
    submit(payload: LeadPayload) {
      if (!payload.first_name && !payload.last_name && !payload.phone && !payload.email) {
        throw new TypeError("A lead needs at least one of: first_name, last_name, phone, email")
      }
      return request<LeadResult>(`${base}/rr/${config.campaignId}/leads`, {
        method: "POST",
        bearer: config.apiKey,
        body: { webhook_key: config.webhookKey, ...payload },
        timeoutMs: 8000,
      })
    },
  }
}
