import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const temp = mkdtempSync(join(tmpdir(), "opencode-chrome-annotation-v2-"))
const project = join(temp, "project")
const install = join(temp, "install")
const password = "integration-test-password"
let server
let stdout = ""
let stderr = ""

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function freePort() {
  const listener = createServer()
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port")
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function authorization() {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

async function api(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: authorization(),
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} returned ${response.status}: ${text}`)
  return body
}

async function eventually(action, predicate, label) {
  const deadline = Date.now() + 15_000
  let value
  let lastError
  while (Date.now() < deadline) {
    try {
      value = await action()
      if (predicate(value)) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${label} did not become ready${lastError ? `: ${lastError.message}` : ""}`)
}

async function stopServer() {
  if (!server || server.exitCode !== null) return
  server.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenCode test server did not stop")), 10_000)),
  ])
}

try {
  mkdirSync(project, { recursive: true })
  mkdirSync(install, { recursive: true })
  execFileSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" })
  const packOutput = execFileSync("npm", ["pack", "--pack-destination", temp, "--json"], { cwd: root, encoding: "utf8" })
  const [{ filename }] = JSON.parse(packOutput)
  const tarball = join(temp, basename(filename))
  writeFileSync(join(install, "package.json"), JSON.stringify({ private: true }, null, 2))
  execFileSync("npm", ["install", "--ignore-scripts", tarball], { cwd: install, stdio: "inherit" })

  const apiPort = await freePort()
  const bridgePort = await freePort()
  const pluginPath = join(install, "node_modules", "opencode-chrome-annotation", "dist", "plugin.js")
  writeFileSync(join(project, "opencode.jsonc"), JSON.stringify({
    plugins: [{
      package: pluginPath,
      options: { portStart: bridgePort, portEnd: bridgePort, resume: false },
    }],
  }, null, 2))

  server = spawn("opencode2", ["serve", "--hostname", "127.0.0.1", "--port", String(apiPort)], {
    cwd: project,
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", (chunk) => { stdout += chunk })
  server.stderr.on("data", (chunk) => { stderr += chunk })
  const baseUrl = `http://127.0.0.1:${apiPort}`
  await eventually(
    () => api(baseUrl, "/api/health"),
    (health) => health?.healthy === true,
    "private OpenCode V2 server",
  )

  const location = encodeURIComponent(project)
  const plugins = await eventually(
    () => api(baseUrl, `/api/plugin?location[directory]=${location}`),
    (result) => result?.data?.some((entry) => entry.id === "opencode.chrome-annotation" && entry.status === "active"),
    "packed V2 plugin",
  )
  assert(plugins.data.some((entry) => entry.id === "opencode.chrome-annotation"), "Plugin ID was not registered")

  const created = await api(baseUrl, "/api/session", {
    method: "POST",
    body: JSON.stringify({ title: "Chrome annotation integration", location: { directory: project } }),
  })
  const sessionId = created.data.id
  const bridgeUrl = `http://127.0.0.1:${bridgePort}`
  await eventually(
    () => fetch(`${bridgeUrl}/sessions`).then((response) => response.json()),
    (result) => result.sessions?.some((session) => session.id === sessionId),
    "event-backed session discovery",
  )

  const extensionHeaders = { origin: "chrome-extension://integration-test", "content-type": "application/json" }
  const claim = await fetch(`${bridgeUrl}/claim`, {
    method: "POST",
    headers: extensionHeaders,
    body: JSON.stringify({ tabId: 17, sessionId, extensionVersion: "integration" }),
  }).then((response) => response.json())
  assert(claim.ok === true, "Bridge rejected the tab claim")

  const screenshot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  const annotationResponse = await fetch(`${bridgeUrl}/annotation`, {
    method: "POST",
    headers: extensionHeaders,
    body: JSON.stringify({
      tabId: 17,
      sessionId,
      extensionVersion: "integration",
      annotation: {
        comment: "Integration annotation",
        page: { title: "Integration page", url: "http://localhost/test" },
        element: { selector: "main > h1", tag: "h1", text: "Hello", rect: {} },
        viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
        screenshot: { mime: "image/png", dataUrl: screenshot },
      },
    }),
  }).then(async (response) => ({ status: response.status, body: await response.json() }))
  assert(annotationResponse.status === 200 && annotationResponse.body.ok === true, "Annotation was not admitted")

  const status = await fetch(`${bridgeUrl}/status`).then((response) => response.json())
  const admittedFile = status.lastAnnotation?.response?.payload?.files?.[0]
  assert(status.lastAnnotation?.ok === true, "Bridge did not record successful admission")
  assert(admittedFile?.mime === "image/png", "Admitted prompt did not materialize a PNG attachment")
  assert(admittedFile?.source?.type === "inline", "Admitted PNG was not an inline attachment")

  await api(baseUrl, `/api/session/${sessionId}`, { method: "DELETE" })
  await eventually(
    () => fetch(`${bridgeUrl}/sessions`).then((response) => response.json()),
    (result) => result.sessions?.every((session) => session.id !== sessionId),
    "session deletion event",
  )

  await stopServer()
  const released = await new Promise((resolve) => {
    const listener = createServer()
    listener.once("error", () => resolve(false))
    listener.listen(bridgePort, "127.0.0.1", () => listener.close(() => resolve(true)))
  })
  assert(released, "Plugin cleanup did not release the bridge listener")
  console.log("OpenCode V2 packed-plugin integration passed")
} catch (error) {
  console.error(error)
  if (stdout.trim()) console.error(`OpenCode stdout:\n${stdout.trim()}`)
  if (stderr.trim()) console.error(`OpenCode stderr:\n${stderr.trim()}`)
  process.exitCode = 1
} finally {
  await stopServer().catch((error) => console.error(error))
  rmSync(temp, { recursive: true, force: true })
}
