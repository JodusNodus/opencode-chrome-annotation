import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { createServer, type Server } from "http";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

const BASE_DIR = getRuntimeBaseDir();
const LOG_PATH = join(BASE_DIR, "plugin.log");
const ANNOTATION_DIR = join(BASE_DIR, "annotations");
const PORT_START = 39240;
const PORT_END = 39260;
const LISTEN_HOST = "127.0.0.1";
const APP_ID = "opencode-chrome-annotation";
const INSTANCE_SESSION_PREFIX = "plugin:";
const CLAIM_TTL_MS = 5 * 60 * 1000;

let cachedVersion: string | null = null;
let processSessionId = `${INSTANCE_SESSION_PREFIX}${Math.random().toString(36).slice(2)}`;
let pluginClient: any = null;
let pluginDirectory = process.cwd();
let pluginSessionLabel = buildSessionLabel(pluginDirectory);
let listeningPort: number | null = null;
let httpServer: Server | null = null;
let serverStartupStatus: "not-started" | "starting" | "listening" | "failed" = "not-started";
let serverStartupError: string | null = null;
const bindFailures: Array<{ port: number; code?: string; message: string }> = [];
let lastAnnotationStatus: Record<string, any> | null = null;
let activeOpencodeSessionId: string | null = null;
let lastExtensionVersion: string | null = null;
const sessionTitles = new Map<string, string>();
const claims = new Map<number, { sessionId: string; claimedAt: string; lastSeenAt: string; extensionVersion?: string }>();

function fallbackSession(): { id: string; title: string; directory: string; status: string } {
  return {
    id: processSessionId,
    title: pluginSessionLabel,
    directory: pluginDirectory,
    status: "open",
  };
}

function getRuntimeBaseDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "opencode-chrome-annotation") : null,
    join(tmpdir(), `opencode-chrome-annotation-${uid ?? "user"}`),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch {
      // Try the next location.
    }
  }

  return join(tmpdir(), `opencode-chrome-annotation-${uid ?? "user"}`);
}

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return pkg.version;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

function buildSessionLabel(directory: string): string {
  const name = basename(directory || process.cwd());
  return name ? `OpenCode: ${name}` : "OpenCode";
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = String(dataUrl).match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) throw new Error("Annotation screenshot must be a base64 data URL");
  return {
    mime: match[1] || "application/octet-stream",
    bytes: Buffer.from(match[2], "base64"),
  };
}

function sanitizeFileStem(value: string): string {
  return String(value || "annotation")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "annotation";
}

function buildAnnotationPrompt(annotation: any): string {
  const comment = typeof annotation?.comment === "string" ? annotation.comment.trim() : "";
  const page = annotation?.page || {};
  const element = annotation?.element || {};
  const rect = element?.rect || {};
  const viewport = annotation?.viewport || {};

  return [
    "Browser annotation from Chrome",
    "",
    "User comment:",
    comment || "(no comment provided)",
    "",
    "Page:",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    typeof annotation?.tabId === "number" ? `Tab ID: ${annotation.tabId}` : "Tab ID: ",
    `Viewport: width=${viewport.width ?? ""} height=${viewport.height ?? ""} devicePixelRatio=${viewport.devicePixelRatio ?? ""}`,
    "",
    "Selected element:",
    `Selector: ${element.selector || ""}`,
    `Tag: ${element.tag || ""}`,
    `Role: ${element.role || ""}`,
    `Text: ${element.text || ""}`,
    `Aria label: ${element.ariaLabel || ""}`,
    `Rect: x=${rect.x ?? ""} y=${rect.y ?? ""} width=${rect.width ?? ""} height=${rect.height ?? ""}`,
    "",
    "Please inspect the screenshot and selected element metadata, then make the appropriate code change.",
  ].join("\n");
}

function isExplicitFalse(value: any): boolean {
  return value === false || value?.data === false;
}

function unwrapClientResult(result: any, action: string): any {
  if (!result || typeof result !== "object") return result;

  if ("error" in result && result.error) {
    const err = result.error;
    const message =
      (typeof err?.message === "string" && err.message) ||
      (typeof err?.error === "string" && err.error) ||
      (typeof err === "string" && err) ||
      `OpenCode ${action} failed`;
    throw new Error(message);
  }

  if ("data" in result) return result.data;
  return result;
}

function setLastAnnotationStatus(status: Record<string, any>): void {
  lastAnnotationStatus = { ...status, time: new Date().toISOString() };
}

function applySessionTitle(sessionId: string, title: string): void {
  const next = String(title || "").trim();
  if (!sessionId || !next) return;
  sessionTitles.set(sessionId, next);
  if (activeOpencodeSessionId === sessionId) {
    pluginSessionLabel = next;
  }
}

function parseSessionTitle(response: any): { id: string; title: string } | null {
  const info = response?.data || response;
  if (!info || typeof info !== "object") return null;
  if (typeof info.id !== "string" || typeof info.title !== "string") return null;
  return { id: info.id, title: info.title };
}

function rememberClaim(tabId: number, sessionId: string, extensionVersion?: string): void {
  const key = Number(tabId);
  const now = new Date().toISOString();
  const prior = claims.get(key);
  const cleanVersion = cleanExtensionVersion(extensionVersion);
  if (cleanVersion) lastExtensionVersion = cleanVersion;
  claims.set(key, {
    sessionId,
    claimedAt: prior?.claimedAt || now,
    lastSeenAt: now,
    extensionVersion: cleanVersion || prior?.extensionVersion,
  });
}

function cleanExtensionVersion(value: any): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pruneStaleClaims(): void {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [tabId, claim] of claims.entries()) {
    const lastSeen = Date.parse(claim.lastSeenAt);
    if (!Number.isFinite(lastSeen) || lastSeen < cutoff) {
      claims.delete(tabId);
    }
  }
}

async function ensureSessionTitle(sessionId: string): Promise<void> {
  if (!sessionId || sessionTitles.has(sessionId) || !pluginClient?.session?.get) return;
  try {
    const response = await pluginClient.session.get({
      path: { id: sessionId },
      query: { directory: pluginDirectory },
    });
    const parsed = parseSessionTitle(response);
    if (parsed) applySessionTitle(parsed.id, parsed.title);
  } catch {
    // ignore
  }
}

async function listOpenCodeSessions(): Promise<Array<{ id: string; title: string; directory?: string; status: string }>> {
  if (!pluginClient?.session?.list) {
    return [fallbackSession()];
  }

  try {
    const response = await pluginClient.session.list({ query: { directory: pluginDirectory } });
    const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
    const sessions = rows
      .filter((item: any) => typeof item?.id === "string" && !item?.time?.archived)
      .map((item: any) => {
        const title = typeof item?.title === "string" && item.title.trim() ? item.title.trim() : `Session ${item.id.slice(0, 8)}`;
        applySessionTitle(item.id, title);
        const updatedAt =
          Number(item?.time?.updated ?? item?.time?.created ?? item?.updatedAt ?? item?.createdAt) || 0;
        return {
          id: item.id,
          title,
          directory: typeof item?.directory === "string" ? item.directory : pluginDirectory,
          status: "open",
          updatedAt,
        };
      });

    if (!sessions.length) return [fallbackSession()];

    if (activeOpencodeSessionId) {
      const active = sessions.find((session: { id: string }) => session.id === activeOpencodeSessionId);
      if (active) {
        const { updatedAt: _updatedAt, ...rest } = active;
        return [rest];
      }

      const activeTitle = sessionTitles.get(activeOpencodeSessionId);
      if (activeTitle) {
        return [
          {
            id: activeOpencodeSessionId,
            title: activeTitle,
            directory: pluginDirectory,
            status: "open",
          },
        ];
      }
    }

    sessions.sort((a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt);
    const { updatedAt: _updatedAt, ...latest } = sessions[0];
    return [latest];
  } catch {
    return [fallbackSession()];
  }
}

function json(res: any, statusCode: number, body: any, origin?: string): void {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: any): Promise<any> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 10 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function listClaims(): Array<Record<string, any>> {
  pruneStaleClaims();
  return Array.from(claims.entries())
    .map(([tabId, info]) => ({ tabId, ...info }))
    .sort((a, b) => a.tabId - b.tabId);
}

async function queueAnnotationPrompt(sessionId: string, annotation: any): Promise<void> {
  if (!pluginClient) {
    setLastAnnotationStatus({ ok: false, sessionId, error: "No OpenCode client is available" });
    throw new Error("No OpenCode client is available");
  }

  setLastAnnotationStatus({
    ok: null,
    sessionId,
    phase: "received",
    commentLength: typeof annotation?.comment === "string" ? annotation.comment.length : 0,
  });

  let promptText = buildAnnotationPrompt(annotation);
  const screenshot = annotation?.screenshot;
  if (screenshot?.dataUrl) {
    mkdirSync(ANNOTATION_DIR, { recursive: true });
    const { mime, bytes } = decodeDataUrl(screenshot.dataUrl);
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const stem = sanitizeFileStem(annotation?.page?.title || annotation?.element?.tag || "annotation");
    const filePath = join(ANNOTATION_DIR, `${Date.now()}-${stem}.${ext}`);
    writeFileSync(filePath, bytes);
    promptText += `\n\nScreenshot: ${filePath}`;
  }

  const promptBody = { parts: [{ type: "text", text: promptText }] };

  if (typeof pluginClient?.session?.promptAsync === "function") {
    const response = await pluginClient.session.promptAsync({
      path: { id: sessionId },
      query: { directory: pluginDirectory },
      body: promptBody,
    });
    const data = unwrapClientResult(response, "session prompt");
    if (isExplicitFalse(data)) throw new Error("OpenCode rejected session prompt submission");
    setLastAnnotationStatus({ ok: true, sessionId, transport: "session.promptAsync", response: data ?? null });
    return;
  }

  if (typeof pluginClient?.session?.prompt === "function") {
    const response = await pluginClient.session.prompt({
      path: { id: sessionId },
      query: { directory: pluginDirectory },
      body: promptBody,
    });
    const data = unwrapClientResult(response, "session prompt");
    if (isExplicitFalse(data)) throw new Error("OpenCode rejected session prompt submission");
    setLastAnnotationStatus({ ok: true, sessionId, transport: "session.prompt", response: data ?? null });
    return;
  }

  const text = promptText;

  const appended = await pluginClient.tui.appendPrompt({
    query: { directory: pluginDirectory },
    body: { text },
  });
  const appendedData = unwrapClientResult(appended, "tui append prompt");
  if (isExplicitFalse(appendedData)) throw new Error("OpenCode rejected appending the annotation prompt");

  const submitted = await pluginClient.tui.submitPrompt({ query: { directory: pluginDirectory } });
  const submittedData = unwrapClientResult(submitted, "tui submit prompt");
  if (isExplicitFalse(submittedData)) throw new Error("OpenCode rejected submitting the annotation prompt");

  setLastAnnotationStatus({ ok: true, sessionId, transport: "tui", response: appendedData ?? null });
}

function buildStatus(): Record<string, any> {
  return {
    app: APP_ID,
    version: getPackageVersion(),
    runtime: {
      platform: process.platform,
      node: process.version,
      tmpdir: tmpdir(),
      xdgRuntimeDir: Boolean(process.env.XDG_RUNTIME_DIR),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
    },
    instanceId: processSessionId,
    sessionId: processSessionId,
    opencodeSessionId: activeOpencodeSessionId,
    label: pluginSessionLabel,
    directory: pluginDirectory,
    runtimeBaseDir: BASE_DIR,
    annotationDir: ANNOTATION_DIR,
    logPath: LOG_PATH,
    server: {
      status: serverStartupStatus,
      host: LISTEN_HOST,
      port: listeningPort,
      startupError: serverStartupError,
      bindFailures,
    },
    port: listeningPort,
    lastExtensionVersion,
    claimTtlMs: CLAIM_TTL_MS,
    claims: listClaims(),
    lastAnnotation: lastAnnotationStatus,
  };
}

async function startServer(): Promise<void> {
  if (listeningPort) return;
  serverStartupStatus = "starting";
  serverStartupError = null;
  bindFailures.length = 0;

  for (let port = PORT_START; port <= PORT_END; port++) {
    const server = createServer(async (req, res) => {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : "*";
      if (req.method === "OPTIONS") {
        json(res, 200, { ok: true }, origin);
        return;
      }

      try {
        const url = new URL(req.url || "/", `http://${LISTEN_HOST}:${port}`);
        if (req.method === "GET" && url.pathname === "/status") {
          json(res, 200, buildStatus(), origin);
          return;
        }

        if (req.method === "GET" && url.pathname === "/sessions") {
          const sessions = await listOpenCodeSessions();
          json(
            res,
            200,
            {
              sessions,
            },
            origin
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          await ensureSessionTitle(sessionId);
          rememberClaim(Number(tabId), sessionId, extensionVersion);
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }

        if (req.method === "POST" && url.pathname === "/annotation") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          const annotation = body?.annotation;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          if (!annotation || typeof annotation !== "object") throw new Error("annotation is required");

          rememberClaim(Number(tabId), sessionId, extensionVersion);

          await queueAnnotationPrompt(sessionId, { ...annotation, tabId: Number(tabId) });
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }

        if (req.method === "POST" && url.pathname === "/unclaim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const extensionVersion = body?.extensionVersion;
          const cleanVersion = cleanExtensionVersion(extensionVersion);
          if (cleanVersion) lastExtensionVersion = cleanVersion;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          claims.delete(Number(tabId));
          json(res, 200, { ok: true }, origin);
          return;
        }

        json(res, 404, { ok: false, error: "Not found" }, origin);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDebug(`http error path=${req.url || ""} error=${message}`);
        json(res, 400, { ok: false, error: message }, origin);
      }
    });

    const started = await new Promise<boolean>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        const failure = {
          port,
          code: error.code,
          message: error.message,
        };
        bindFailures.push(failure);
        logDebug(`http bind failed port=${port} code=${failure.code || ""} error=${failure.message}`);
        resolve(false);
      });
      server.listen(port, LISTEN_HOST, () => resolve(true));
    });

    if (!started) continue;
    httpServer = server;
    listeningPort = port;
    serverStartupStatus = "listening";
    logDebug(`http server listening port=${port} session=${processSessionId} label=${JSON.stringify(pluginSessionLabel)}`);
    return;
  }

  serverStartupStatus = "failed";
  serverStartupError = `Could not bind OpenCode annotation server on ${LISTEN_HOST} ports ${PORT_START}-${PORT_END}`;
  throw new Error(serverStartupError);
}

const plugin: Plugin = async (ctx) => {
  pluginClient = ctx.client;
  pluginDirectory = ctx.directory || process.cwd();
  pluginSessionLabel = buildSessionLabel(ctx.worktree || pluginDirectory);

  startServer().catch((error) => {
    serverStartupStatus = "failed";
    serverStartupError = error instanceof Error ? error.message : String(error);
    logDebug(`server startup failed error=${serverStartupError}`);
  });

  return {
    event: async ({ event }) => {
      const info = (event as any)?.properties?.info;
      if ((event as any)?.type === "session.created" || (event as any)?.type === "session.updated") {
        if (typeof info?.id === "string" && typeof info?.title === "string") {
          applySessionTitle(info.id, info.title);
        }
      }
      if ((event as any)?.type === "session.deleted" && typeof info?.id === "string") {
        sessionTitles.delete(info.id);
        if (activeOpencodeSessionId === info.id) {
          activeOpencodeSessionId = null;
          pluginSessionLabel = buildSessionLabel(pluginDirectory);
        }
      }
    },
    "chat.message": async (input) => {
      if (!input?.sessionID) return;
      activeOpencodeSessionId = input.sessionID;
      if (sessionTitles.has(input.sessionID)) {
        pluginSessionLabel = sessionTitles.get(input.sessionID) as string;
        return;
      }
      await ensureSessionTitle(input.sessionID);
    },
    tool: {
      chrome_status: {
        description: "Report OpenCode Chrome Annotation local server, session, tab claim, and last annotation status.",
        args: {},
        execute: async () => JSON.stringify(buildStatus(), null, 2),
      },
    },
  };
};

export default plugin;
