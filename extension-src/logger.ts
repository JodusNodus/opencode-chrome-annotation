export function logExtension(message: string, details?: unknown) {
  if (details === undefined) {
    console.log(`[OpenCode] ${message}`)
    return
  }
  console.log(`[OpenCode] ${message}`, details)
}

export function warnExtension(message: string, details?: unknown) {
  if (details === undefined) {
    console.warn(`[OpenCode] ${message}`)
    return
  }
  console.warn(`[OpenCode] ${message}`, details)
}

export function errorExtension(message: string, details?: unknown) {
  if (details === undefined) {
    console.error(`[OpenCode] ${message}`)
    return
  }
  console.error(`[OpenCode] ${message}`, details)
}
