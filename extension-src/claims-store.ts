import type { ClaimsStore, TabClaim } from "./types.js"

export function createClaimsStore(): ClaimsStore {
  const claims = new Map<number, TabClaim>()
  const storageKey = "opencodeChromeAnnotationClaims"

  function storage(): chrome.storage.StorageArea | undefined {
    return chrome.storage?.session || chrome.storage?.local
  }

  async function save() {
    const area = storage()
    if (!area) return
    await area.set({
      [storageKey]: Array.from(claims.entries()),
    })
  }

  return {
    async restore() {
      const area = storage()
      if (!area) return
      const result = await area.get(storageKey)
      const entries = Array.isArray(result?.[storageKey]) ? result[storageKey] : []
      claims.clear()
      for (const [tabId, claim] of entries) {
        if (Number.isFinite(Number(tabId)) && claim?.sessionId && claim?.baseUrl) {
          claims.set(Number(tabId), claim)
        }
      }
    },
    get(tabId: number | undefined) {
      if (tabId === undefined) return undefined
      return claims.get(tabId)
    },
    set(tabId: number, claim: TabClaim) {
      claims.set(tabId, claim)
      save().catch(() => {})
    },
    delete(tabId: number | undefined) {
      if (tabId === undefined) return false
      const deleted = claims.delete(tabId)
      if (deleted) save().catch(() => {})
      return deleted
    },
    entries() {
      return claims.entries()
    },
    values() {
      return claims.values()
    },
    size() {
      return claims.size
    },
  }
}
