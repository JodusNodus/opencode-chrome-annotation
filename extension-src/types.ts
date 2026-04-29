export type SessionInfo = {
  id: string
  title?: string
  directory?: string
  status?: string
  baseUrl: string
}

export type SessionPickerReason = "plugin-not-found" | "no-sessions"

export type SessionPickerContext = {
  reason?: SessionPickerReason
  instanceCount: number
}

export type SessionQueryResult = {
  sessions: SessionInfo[]
  context: SessionPickerContext
}

export type TabClaim = {
  sessionId: string
  sessionLabel?: string
  baseUrl: string
  origin?: string | null
  extensionVersion?: string
}

export type AnnotationElement = {
  selector: string
  tag: string
  role: string
  text: string
  ariaLabel: string | null
  id: string | null
  className: string
  rect: {
    x: number
    y: number
    width: number
    height: number
  }
}

export type AnnotationViewport = {
  width: number
  height: number
  devicePixelRatio: number
}

export type AnnotationPickerResult =
  | { cancelled: true }
  | {
      cancelled: false
      comment: string
      element: AnnotationElement
      viewport: AnnotationViewport
    }

export type AnnotationPayload = {
  comment: string
  page: {
    url: string
    title: string
  }
  element: AnnotationElement
  viewport: AnnotationViewport
  screenshot: {
    mime: "image/png"
    dataUrl: string
  }
}

export type ExtensionMessage =
  | { type: "start_annotation_from_overlay" }
  | { type: "connect_tab_to_session"; session: SessionInfo }
  | { type: "disconnect_tab" }
  | { type: "refresh_sessions" }

export type InstanceStatus = {
  app?: string
  [key: string]: unknown
}

export type DiscoveredInstance = {
  baseUrl: string
  status: InstanceStatus
}

export type JsonResult<T = unknown> = {
  ok: boolean
  status: number
  payload: T | null
}

export type ClaimsStore = {
  restore(): Promise<void>
  get(tabId: number | undefined): TabClaim | undefined
  set(tabId: number, claim: TabClaim): void
  delete(tabId: number | undefined): boolean
  entries(): IterableIterator<[number, TabClaim]>
  values(): IterableIterator<TabClaim>
  size(): number
}
