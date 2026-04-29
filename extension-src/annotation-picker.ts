import { logExtension, warnExtension } from "./logger.js"
import type { AnnotationElement, AnnotationPickerResult, AnnotationViewport } from "./types.js"

function annotationPickerScript(): Promise<AnnotationPickerResult> {
  const h = globalThis.__opc_h!
  if (typeof h !== "function") {
    throw new Error("OpenCode UI helper is unavailable")
  }

  const STYLE = {
    root: "position:fixed;inset:0;z-index:2147483647;pointer-events:none;",
    box: "position:fixed;border:2px solid rgba(34,197,94,0.95);background:rgba(34,197,94,0.16);box-shadow:0 0 0 1px rgba(34,197,94,0.45);pointer-events:none;",
    panel: "position:fixed;right:16px;bottom:16px;width:320px;padding:12px;background:rgba(15,23,42,0.92);color:#bbf7d0;border:1px solid rgba(34,197,94,0.45);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.35);font:12px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:auto;display:none;backdrop-filter:blur(8px);",
    title: "font-weight:600;margin-bottom:8px;",
    targetInfo: "margin-bottom:8px;color:#86efac;word-break:break-word;",
    textarea: "width:100%;min-height:96px;resize:vertical;border-radius:10px;border:1px solid rgba(34,197,94,0.35);background:rgba(2,44,34,0.75);color:#dcfce7;padding:10px;box-sizing:border-box;",
    actions: "display:flex;gap:8px;justify-content:flex-end;margin-top:10px;",
    cancel: "padding:8px 10px;border-radius:999px;border:1px solid rgba(34,197,94,0.45);background:transparent;color:#bbf7d0;cursor:pointer;",
    submit: "padding:8px 12px;border-radius:999px;border:0;background:#22c55e;color:#052e16;font-weight:600;cursor:pointer;",
  }

  const ROLE_BY_TAG = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    SELECT: "combobox",
    TEXTAREA: "textbox",
  }

  function removeExistingRoot() {
    document.getElementById("__opc_annotation_root")?.remove()
  }

  function cssEscape(value: string): string {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value)
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&")
  }

  function inferRole(el: HTMLElement): string {
    return el.getAttribute("role") || ROLE_BY_TAG[el.tagName as keyof typeof ROLE_BY_TAG] || ""
  }

  function buildSelector(el: HTMLElement | null): string {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return ""
    if (el.id) return `#${cssEscape(el.id)}`

    const parts: string[] = []
    let current: HTMLElement | null = el
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      let part = current.tagName.toLowerCase()
      if (current.classList && current.classList.length) {
        part += "." + Array.from(current.classList).slice(0, 2).map(cssEscape).join(".")
      }
      const parent = current.parentElement
      if (parent) {
        const currentTag = current.tagName
        const siblings = Array.from(parent.children).filter((child: Element) => child.tagName === currentTag)
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`
        }
      }
      parts.unshift(part)
      if (current.parentElement?.id) {
        parts.unshift(`#${cssEscape(current.parentElement.id)}`)
        break
      }
      current = current.parentElement
    }
    return parts.join(" > ")
  }

  function describeElement(el: HTMLElement): AnnotationElement {
    const rect = el.getBoundingClientRect()
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      role: inferRole(el),
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500),
      ariaLabel: el.getAttribute("aria-label"),
      id: el.id || null,
      className: typeof el.className === "string" ? el.className : "",
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    }
  }

  function describeViewport(): AnnotationViewport {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    }
  }

  function createUI() {
    const root = h("div", { style: STYLE.root, attrs: { id: "__opc_annotation_root" } })
    root.id = "__opc_annotation_root"

    const box = h("div", { style: STYLE.box })
    const targetInfo = h("div", { style: STYLE.targetInfo })
    const textarea = h("textarea", { style: STYLE.textarea }) as HTMLTextAreaElement
    textarea.placeholder = "What should OpenCode change here?"

    const cancelButton = h("button", {
      text: "Cancel",
      style: STYLE.cancel,
      attrs: { type: "button" },
    }) as HTMLButtonElement
    const submitButton = h("button", {
      text: "Send",
      style: STYLE.submit,
      attrs: { type: "button" },
    }) as HTMLButtonElement

    const panel = h("div", { style: STYLE.panel }, [
      h("div", { text: "Annotate selection", style: STYLE.title }),
      targetInfo,
      textarea,
      h("div", { style: STYLE.actions }, [cancelButton, submitButton]),
    ])

    root.appendChild(box)
    root.appendChild(panel)
    document.documentElement.appendChild(root)

    return { root, box, panel, targetInfo, textarea, cancelButton, submitButton }
  }

  function updateHighlight(box: HTMLElement, el: HTMLElement | null): void {
    if (!el) {
      box.style.display = "none"
      return
    }
    const rect = el.getBoundingClientRect()
    box.style.display = "block"
    box.style.top = `${rect.top}px`
    box.style.left = `${rect.left}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
  }

  return new Promise((resolve) => {
    removeExistingRoot()
    const ui = createUI()

    const state: { selected: HTMLElement | null; locked: boolean; finished: boolean } = {
      selected: null,
      locked: false,
      finished: false,
    }

    function removeListeners() {
      document.removeEventListener("mousemove", onMouseMove, true)
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }

    function finish(resultPayload: AnnotationPickerResult) {
      if (state.finished) return
      state.finished = true
      removeListeners()
      ui.root.remove()
      resolve(resultPayload)
    }

    function finishWithSendAnimation(resultPayload: AnnotationPickerResult) {
      if (state.finished) return
      state.finished = true
      removeListeners()
      ui.submitButton.disabled = true
      ui.cancelButton.disabled = true
      ui.textarea.disabled = true
      ui.submitButton.textContent = "Sending"
      ui.panel.style.transition = "transform 220ms cubic-bezier(.2,.8,.2,1), opacity 180ms ease"
      ui.box.style.transition = "opacity 160ms ease"
      requestAnimationFrame(() => {
        ui.panel.style.transform = "translateX(calc(100% + 40px))"
        ui.panel.style.opacity = "0"
        ui.box.style.opacity = "0"
      })
      setTimeout(() => {
        ui.root.remove()
        resolve(resultPayload)
      }, 240)
    }

    function submitAnnotation() {
      if (!state.selected) {
        finish({ cancelled: true })
        return
      }
      finishWithSendAnimation({
        cancelled: false,
        comment: ui.textarea.value.trim(),
        element: describeElement(state.selected),
        viewport: describeViewport(),
      })
    }

    function onMouseMove(event: MouseEvent) {
      if (state.locked) return
      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      if (!el || ui.root.contains(el)) return
      state.selected = el
      updateHighlight(ui.box, el)
    }

    function onClick(event: MouseEvent) {
      if (event.target instanceof Node && ui.panel.contains(event.target)) return
      if (state.locked) return
      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
      if (!el || ui.root.contains(el)) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      state.locked = true
      state.selected = el
      updateHighlight(ui.box, el)
      ui.targetInfo.textContent = `${el.tagName.toLowerCase()} ${buildSelector(el)}`.trim()
      ui.panel.style.display = "block"
      ui.textarea.focus()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        finish({ cancelled: true })
        return
      }
      if (state.locked && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        submitAnnotation()
      }
    }

    ui.cancelButton.addEventListener("click", () => finish({ cancelled: true }))
    ui.submitButton.addEventListener("click", submitAnnotation)

    document.addEventListener("mousemove", onMouseMove, true)
    document.addEventListener("click", onClick, true)
    document.addEventListener("keydown", onKeyDown, true)
  })
}

export async function runAnnotationPicker(tabId: number): Promise<AnnotationPickerResult | null> {
  logExtension("Starting annotation picker", { tabId })
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: ["injected/dom.js"],
  })
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: annotationPickerScript,
  })

  const picked = result[0]?.result || null
  if (!picked) {
    warnExtension("Annotation picker returned no result", { tabId })
    return null
  }

  if (picked.cancelled === true) {
    logExtension("Annotation picker cancelled", { tabId })
  } else {
    logExtension("Annotation picker selected element", {
      tabId,
      selector: picked.element?.selector,
      tag: picked.element?.tag,
      commentLength: typeof picked.comment === "string" ? picked.comment.length : 0,
    })
  }

  return picked
}
