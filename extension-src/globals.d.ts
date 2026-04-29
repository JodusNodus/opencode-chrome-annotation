declare global {
  type OpcElementOptions = {
    text?: string
    style?: string
    attrs?: Record<string, string>
    on?: Record<string, EventListener>
  }

  type OpcDockApi = {
    applyDockPosition(dock?: string): void
  }

  var __opc_h: ((tag: string, options?: OpcElementOptions, children?: Node[]) => HTMLElement) | undefined
  var __opc_makeDockable: ((overlay: HTMLElement, options?: { blockDragSelector?: string; snapThreshold?: number }) => OpcDockApi) | undefined
  var __opc_cleanupSessionPicker: (() => void) | undefined

  interface HTMLElement {
    __opcDockApi?: OpcDockApi
  }
}

export {}
