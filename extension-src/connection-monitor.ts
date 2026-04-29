import {
  CONNECTION_CHECK_INTERVAL_MS,
  CONNECTION_STATUS_TIMEOUT_MS,
} from "./constants.js"
import { checkServerStatus, postJson } from "./server-api.js"
import { warnExtension } from "./logger.js"
import type { ClaimsStore, TabClaim } from "./types.js"

type ConnectionMonitorOptions = {
  claimedTabs: ClaimsStore
  removeConnectionOverlay(tabId: number): Promise<void>
  extensionVersion: string
}

export function createConnectionMonitor({ claimedTabs, removeConnectionOverlay, extensionVersion }: ConnectionMonitorOptions) {
  let timer: ReturnType<typeof setInterval> | null = null

  function heartbeatClaim(tabId: number, claim: TabClaim): Promise<unknown> | null {
    if (!claim?.baseUrl || !claim?.sessionId) return null
    return postJson(claim.baseUrl, "/claim", {
      tabId,
      sessionId: claim.sessionId,
      extensionVersion,
    })
  }

  function stop() {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  function ensure() {
    if (timer !== null) return
    timer = setInterval(() => {
      check().catch(() => {})
    }, CONNECTION_CHECK_INTERVAL_MS)
  }

  async function check() {
    if (!claimedTabs.size()) {
      stop()
      return
    }

    const baseUrls = new Set<string>()
    for (const claim of claimedTabs.values()) {
      if (claim?.baseUrl) baseUrls.add(claim.baseUrl)
    }

    const settled = await Promise.allSettled(
      Array.from(baseUrls).map(async (baseUrl) => ({
        baseUrl,
        ok: await checkServerStatus(baseUrl, CONNECTION_STATUS_TIMEOUT_MS),
      }))
    )

    const disconnected = new Set<string>()
    for (const result of settled) {
      if (result.status !== "fulfilled") continue
      if (!result.value.ok) disconnected.add(result.value.baseUrl)
    }

    await Promise.allSettled(
      Array.from(claimedTabs.entries()).map(([tabId, claim]) => {
        if (disconnected.has(claim?.baseUrl)) return null
        return heartbeatClaim(tabId, claim)
      })
    )

    if (!disconnected.size) return

    for (const [tabId, claim] of claimedTabs.entries()) {
      if (!disconnected.has(claim?.baseUrl)) continue
      claimedTabs.delete(tabId)
      await removeConnectionOverlay(tabId)
    }

    warnExtension("Lost connection to OpenCode instance", {
      disconnectedInstances: Array.from(disconnected),
      remainingClaims: claimedTabs.size(),
    })

    if (!claimedTabs.size()) stop()
  }

  return { ensure, stop, check }
}
