import { warnExtension } from "./logger.js"

export async function injectConnectionOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["injected/dom.js"],
    })

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        const makeDockable = globalThis.__opc_makeDockable
        if (typeof makeDockable !== "function") {
          throw new Error("OpenCode dock helper is unavailable")
        }

        function createCloseIcon() {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
          svg.setAttribute("viewBox", "0 0 12 12")
          svg.setAttribute("width", "12")
          svg.setAttribute("height", "12")
          svg.setAttribute("aria-hidden", "true")

          const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
          path.setAttribute("d", "M2 2 L10 10 M10 2 L2 10")
          path.setAttribute("stroke", "currentColor")
          path.setAttribute("stroke-width", "1.8")
          path.setAttribute("stroke-linecap", "round")
          svg.appendChild(path)
          return svg
        }

        let overlay = document.getElementById("__opc_connection_overlay")
        if (!overlay) {
          overlay = document.createElement("div")
          overlay.id = "__opc_connection_overlay"
          overlay.style.cssText = [
            "position:fixed",
            "left:50%",
            "z-index:2147483647",
            "transform:translateX(-50%)",
            "display:flex",
            "align-items:center",
            "gap:8px",
            "padding:6px 8px 6px 10px",
            "border-radius:999px",
            "background:rgba(15,23,42,0.92)",
            "color:#bbf7d0",
            "border:1px solid rgba(34,197,94,0.45)",
            "box-shadow:0 8px 24px rgba(0,0,0,0.22)",
            "font:12px/1.2 ui-sans-serif,system-ui,sans-serif",
            "pointer-events:auto",
            "backdrop-filter:blur(8px)",
            "cursor:grab",
            "user-select:none",
            "-webkit-user-select:none",
          ].join(";")

          const label = document.createElement("span")
          label.dataset.role = "label"
          overlay.appendChild(label)

          const button = document.createElement("button")
          button.type = "button"
          button.textContent = "Annotate"
          button.style.cssText = [
            "border:0",
            "border-radius:999px",
            "padding:4px 8px",
            "background:#22c55e",
            "color:#052e16",
            "font:600 11px/1 ui-sans-serif,system-ui,sans-serif",
            "cursor:pointer",
          ].join(";")
          button.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            try {
              chrome.runtime.sendMessage({ type: "start_annotation_from_overlay" })
            } catch {}
          })
          overlay.appendChild(button)

          const closeButton = document.createElement("button")
          closeButton.type = "button"
          closeButton.setAttribute("aria-label", "Disconnect tab")
          closeButton.style.cssText = [
            "border:0",
            "padding:0 2px",
            "background:transparent",
            "color:#bbf7d0",
            "font:700 14px/1 ui-sans-serif,system-ui,sans-serif",
            "cursor:pointer",
          ].join(";")
          closeButton.appendChild(createCloseIcon())
          closeButton.addEventListener("click", (event: MouseEvent) => {
            event.preventDefault()
            event.stopPropagation()
            try {
              chrome.runtime.sendMessage({ type: "disconnect_tab" })
            } catch {}
          })
          overlay.appendChild(closeButton)
          document.documentElement.appendChild(overlay)
        }
        const dockable = makeDockable(overlay, { blockDragSelector: "button", snapThreshold: 10 })
        dockable.applyDockPosition(overlay.dataset.dock)
        const label = overlay.querySelector("[data-role='label']")
        if (label) label.textContent = "Connected"
      },
    })
  } catch (error) {
    warnExtension("Failed to inject connection overlay", { tabId, error: error instanceof Error ? error.message : String(error) })
  }
}

export async function removeConnectionOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => {
        document.getElementById("__opc_connection_overlay")?.remove()
      },
    })
  } catch {
    // Tab may have closed or disallow injection.
  }
}

export async function showAnnotationError(tabId: number, message: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    args: [message],
    func: (errorMessage: string) => {
      const existing = document.getElementById("__opc_annotation_error")
      if (existing) existing.remove()

      const panel = document.createElement("div")
      panel.id = "__opc_annotation_error"
      panel.textContent = `OpenCode annotation failed: ${errorMessage}`
      panel.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:12px 14px",
        "border-radius:10px",
        "background:#7f1d1d",
        "color:#fee2e2",
        "border:1px solid rgba(254,202,202,0.45)",
        "box-shadow:0 10px 30px rgba(0,0,0,0.35)",
        "font:13px/1.4 ui-sans-serif,system-ui,sans-serif",
        "transform:translateX(calc(100% + 40px))",
        "opacity:0",
        "transition:transform 180ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease",
      ].join(";")
      document.documentElement.appendChild(panel)
      requestAnimationFrame(() => {
        panel.style.transform = "translateX(0)"
        panel.style.opacity = "1"
      })
      setTimeout(() => {
        panel.style.transform = "translateX(calc(100% + 40px))"
        panel.style.opacity = "0"
        setTimeout(() => panel.remove(), 220)
      }, 7000)
    },
  })
}
