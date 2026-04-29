import { APP_ID, DISCOVERY_TIMEOUT_MS, PORT_END, PORT_START } from "./constants.js"
import type { DiscoveredInstance, InstanceStatus, JsonResult, SessionInfo, SessionQueryResult } from "./types.js"

type FetchJsonOptions = {
  method?: string
  body?: unknown
  timeoutMs?: number
  throwOnHttp?: boolean
}

type SessionsResponse = {
  sessions?: Array<Omit<SessionInfo, "baseUrl">>
}

async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<JsonResult<T>> {
  const {
    method = "GET",
    body,
    timeoutMs,
    throwOnHttp = true,
  } = options

  const controller = Number.isFinite(timeoutMs) ? new AbortController() : null
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const headers: Record<string, string> = {}
    let payloadBody: string | undefined
    if (body !== undefined) {
      headers["content-type"] = "application/json"
      payloadBody = JSON.stringify(body)
    }

    const response = await fetch(url, {
      method,
      headers,
      body: payloadBody,
      signal: controller?.signal,
    })

    const payload = await response.json().catch((): null => null) as T | null
    if (throwOnHttp && !response.ok) throw new Error(`status ${response.status}`)

    return {
      ok: response.ok,
      status: response.status,
      payload,
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function discoverInstances(): Promise<DiscoveredInstance[]> {
  const ports: number[] = []
  for (let portNumber = PORT_START; portNumber <= PORT_END; portNumber++) ports.push(portNumber)

  const settled = await Promise.allSettled(
    ports.map(async (portNumber) => {
      const result = await fetchJson<InstanceStatus>(`http://127.0.0.1:${portNumber}/status`, {
        timeoutMs: DISCOVERY_TIMEOUT_MS,
      })
      if (result.payload?.app !== APP_ID) throw new Error("not annotation server")
      return { baseUrl: `http://127.0.0.1:${portNumber}`, status: result.payload }
    })
  )

  return settled.filter((item) => item.status === "fulfilled").map((item) => item.value)
}

export async function postJson<T = Record<string, unknown>>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const result = await fetchJson<Record<string, unknown>>(`${baseUrl}${path}`, {
    method: "POST",
    body: body || {},
  })
  const payload = result.payload || {}
  if (payload?.ok === false) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Request failed (${result.status})`)
  }
  return payload as T
}

export async function requestSessionState(): Promise<SessionQueryResult> {
  const instances = await discoverInstances()
  if (!instances.length) {
    return {
      sessions: [],
      context: { reason: "plugin-not-found", instanceCount: 0 },
    }
  }

  const sessions: SessionInfo[] = []
  for (const instance of instances) {
    try {
      const result = await fetchJson<SessionsResponse>(`${instance.baseUrl}/sessions`, { throwOnHttp: false })
      if (!result.ok) continue
      const payload = result.payload
      const list = Array.isArray(payload?.sessions) ? payload.sessions : []
      for (const item of list) sessions.push({ ...item, baseUrl: instance.baseUrl })
    } catch {
      // ignore dead instance
    }
  }
  return {
    sessions,
    context: {
      reason: sessions.length ? undefined : "no-sessions",
      instanceCount: instances.length,
    },
  }
}

export async function requestSessions(): Promise<SessionInfo[]> {
  return (await requestSessionState()).sessions
}

export async function checkServerStatus(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const result = await fetchJson<InstanceStatus>(`${baseUrl}/status`, {
      timeoutMs,
      throwOnHttp: false,
    })
    if (!result.ok) return false
    return result.payload?.app === APP_ID
  } catch {
    return false
  }
}
