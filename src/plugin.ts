import { Plugin } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ID = "opencode-chrome-annotation";
const LISTEN_HOST = "127.0.0.1";
const DEFAULT_PORT_START = 39240;
const DEFAULT_PORT_END = 39260;
const WEB_STORE_EXTENSION_ORIGIN = "chrome-extension://abeihanpaeioklkhioiigklonbomhjfd";
const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

type SessionRecord = {
  id: string;
  title: string;
  directory?: string;
  status: "open";
  updatedAt: number;
};

type Claim = {
  sessionId: string;
  claimedAt: string;
  lastSeenAt: string;
  extensionVersion?: string;
};

function runtimeBaseDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, APP_ID) : null,
    join(tmpdir(), `${APP_ID}-${uid}`),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch {
      // Try the next runtime location.
    }
  }

  return join(tmpdir(), `${APP_ID}-${uid}`);
}

function packageVersion(): string {
  try {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(moduleDirectory, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function annotationPrompt(annotation: any): string {
  const page = annotation?.page || {};
  const element = annotation?.element || {};
  const rect = element?.rect || {};
  const viewport = annotation?.viewport || {};
  const comment = typeof annotation?.comment === "string" ? annotation.comment.trim() : "";

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

const plugin = Plugin.define({
  id: "opencode.chrome-annotation",
  setup: async (ctx) => {
    const options = ctx.options as Record<string, unknown>;
    const portStart = Number.isInteger(options.portStart) ? Number(options.portStart) : DEFAULT_PORT_START;
    const portEnd = Number.isInteger(options.portEnd) ? Number(options.portEnd) : DEFAULT_PORT_END;
    const resume = options.resume === true;
    const eventRetryMs = Number.isInteger(options.eventRetryMs) && Number(options.eventRetryMs) >= 0
      ? Number(options.eventRetryMs)
      : 1_000;
    const allowedExtensionOrigins = new Set([
      WEB_STORE_EXTENSION_ORIGIN,
      ...(Array.isArray(options.allowedExtensionOrigins)
        ? options.allowedExtensionOrigins.filter((origin): origin is string => typeof origin === "string")
        : []),
    ]);
    const baseDir = runtimeBaseDir();
    const logPath = join(baseDir, "plugin.log");
    const sessions = new Map<string, SessionRecord>();
    const claims = new Map<number, Claim>();
    const bindFailures: Array<{ port: number; code?: string; message: string }> = [];
    const instanceId = `plugin:${crypto.randomUUID()}`;
    let server: Server | null = null;
    let listeningPort: number | null = null;
    let selectedSessionId: string | null = null;
    let lastExtensionVersion: string | null = null;
    let lastAnnotation: Record<string, unknown> | null = null;
    let startupStatus: "starting" | "listening" | "failed" = "starting";
    let startupError: string | null = null;

    const log = (message: string) => {
      try {
        appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
      } catch {
        // Diagnostics must not break annotation delivery.
      }
    };

    const pruneClaims = () => {
      const cutoff = Date.now() - CLAIM_TTL_MS;
      for (const [tabId, claim] of claims) {
        if (Date.parse(claim.lastSeenAt) < cutoff) claims.delete(tabId);
      }
    };

    const status = () => {
      pruneClaims();
      const selected = selectedSessionId ? sessions.get(selectedSessionId) : undefined;
      return {
        app: APP_ID,
        version: packageVersion(),
        instanceId,
        opencodeSessionId: selectedSessionId,
        label: selected?.title || "OpenCode",
        directory: selected?.directory,
        runtimeBaseDir: baseDir,
        logPath,
        server: {
          status: startupStatus,
          host: LISTEN_HOST,
          port: listeningPort,
          startupError,
          bindFailures,
        },
        port: listeningPort,
        lastExtensionVersion,
        claimTtlMs: CLAIM_TTL_MS,
        claims: [...claims.entries()].map(([tabId, claim]) => ({ tabId, ...claim })),
        lastAnnotation,
      };
    };

    const sendJson = (res: any, statusCode: number, body: unknown, origin?: string) => {
      if (origin && allowedExtensionOrigins.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    };

    const readBody = (req: any): Promise<any> => new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      req.on("data", (chunk: Buffer) => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          failed = true;
          reject(new Error("Request body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (failed) return;
        try {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error("Invalid JSON body"));
        }
      });
      req.on("error", reject);
    });

    const rememberClaim = (tabId: number, sessionId: string, extensionVersion?: unknown) => {
      const now = new Date().toISOString();
      const prior = claims.get(tabId);
      const version = typeof extensionVersion === "string" && extensionVersion.trim() ? extensionVersion.trim() : undefined;
      if (version) lastExtensionVersion = version;
      claims.set(tabId, {
        sessionId,
        claimedAt: prior?.claimedAt || now,
        lastSeenAt: now,
        extensionVersion: version || prior?.extensionVersion,
      });
    };

    const handleRequest = async (req: any, res: any, port: number) => {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      if (origin && !allowedExtensionOrigins.has(origin)) {
        sendJson(res, 403, { ok: false, error: "Origin not allowed" });
        return;
      }
      if (req.method === "OPTIONS") {
        sendJson(res, 204, { ok: true }, origin);
        return;
      }

      try {
        const url = new URL(req.url || "/", `http://${LISTEN_HOST}:${port}`);
        if (req.method === "GET" && url.pathname === "/status") {
          sendJson(res, 200, status(), origin);
          return;
        }
        if (req.method === "GET" && url.pathname === "/sessions") {
          const rows = [...sessions.values()]
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .map(({ updatedAt: _updatedAt, ...session }) => session);
          sendJson(res, 200, { sessions: rows }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readBody(req);
          if (!Number.isFinite(body?.tabId)) throw new Error("tabId is required");
          if (typeof body?.sessionId !== "string" || !body.sessionId) throw new Error("sessionId is required");
          if (!sessions.has(body.sessionId)) throw new Error("session is not available");
          rememberClaim(Number(body.tabId), body.sessionId, body.extensionVersion);
          selectedSessionId = body.sessionId;
          sendJson(res, 200, { ok: true, sessionId: body.sessionId }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/annotation") {
          const body = await readBody(req);
          if (!Number.isFinite(body?.tabId)) throw new Error("tabId is required");
          if (typeof body?.sessionId !== "string" || !body.sessionId) throw new Error("sessionId is required");
          if (!body?.annotation || typeof body.annotation !== "object") throw new Error("annotation is required");
          pruneClaims();
          const claim = claims.get(Number(body.tabId));
          if (!claim || claim.sessionId !== body.sessionId) throw new Error("tab is not claimed by this session");

          rememberClaim(Number(body.tabId), body.sessionId, body.extensionVersion);
          const screenshot = body.annotation.screenshot;
          if (typeof screenshot?.dataUrl === "string" && screenshot.dataUrl &&
            !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot.dataUrl)) {
            throw new Error("screenshot must be a supported base64 image data URL");
          }
          const files = typeof screenshot?.dataUrl === "string" && screenshot.dataUrl
            ? [{
                uri: screenshot.dataUrl,
                name: "browser-annotation.png",
                description: "Visible browser tab for the selected element",
              }]
            : undefined;
          lastAnnotation = {
            ok: null,
            phase: "received",
            sessionId: body.sessionId,
            time: new Date().toISOString(),
          };
          try {
            const result = await ctx.session.prompt({
              sessionID: body.sessionId,
              text: annotationPrompt({ ...body.annotation, tabId: Number(body.tabId) }),
              files,
              delivery: resume ? "steer" : "queue",
              resume,
              metadata: { source: "chrome-annotation" },
            });
            lastAnnotation = {
              ok: true,
              sessionId: body.sessionId,
              transport: "session.prompt",
              queued: !resume,
              messageId: result.id,
              messageType: result.type,
              time: new Date().toISOString(),
            };
          } catch (error) {
            lastAnnotation = {
              ok: false,
              sessionId: body.sessionId,
              error: error instanceof Error ? error.message : String(error),
              time: new Date().toISOString(),
            };
            throw error;
          }
          sendJson(res, 200, { ok: true, sessionId: body.sessionId, queued: !resume }, origin);
          return;
        }
        if (req.method === "POST" && url.pathname === "/unclaim") {
          const body = await readBody(req);
          if (!Number.isFinite(body?.tabId)) throw new Error("tabId is required");
          const version = typeof body.extensionVersion === "string" && body.extensionVersion.trim()
            ? body.extensionVersion.trim()
            : undefined;
          if (version) lastExtensionVersion = version;
          claims.delete(Number(body.tabId));
          sendJson(res, 200, { ok: true }, origin);
          return;
        }
        sendJson(res, 404, { ok: false, error: "Not found" }, origin);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`http error path=${req.url || ""} error=${message}`);
        sendJson(res, 400, { ok: false, error: message }, origin);
      }
    };

    const toolRegistration = await ctx.tool.transform((tools) => {
      tools.add({
        name: "chrome_status",
        description: "Report OpenCode Chrome Annotation server, session, claim, and delivery status.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: JSON.stringify(status(), null, 2) }),
      });
    });

    for (let port = portStart; port <= portEnd; port++) {
      const candidate = createServer((req, res) => void handleRequest(req, res, port));
      const result = await new Promise<{ ok: true } | { ok: false; error: NodeJS.ErrnoException }>((resolve) => {
        candidate.once("error", (error: NodeJS.ErrnoException) => resolve({ ok: false, error }));
        candidate.listen(port, LISTEN_HOST, () => resolve({ ok: true }));
      });
      if (!result.ok) {
        bindFailures.push({ port, code: result.error.code, message: result.error.message });
        continue;
      }
      server = candidate;
      listeningPort = port;
      startupStatus = "listening";
      log(`http server listening port=${port} instance=${instanceId}`);
      break;
    }

    if (!server) {
      startupStatus = "failed";
      startupError = `Could not bind ${APP_ID} on ${LISTEN_HOST} ports ${portStart}-${portEnd}`;
      await toolRegistration.dispose();
      throw new Error(startupError);
    }

    let stopping = false;
    let stopEvents: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => { stopEvents = resolve; });
    const hydrateSession = async (sessionId: string, updatedAt: number) => {
      try {
        const session = await ctx.session.get({ sessionID: sessionId });
        sessions.set(sessionId, {
          id: sessionId,
          title: session.title || `Session ${sessionId.slice(0, 8)}`,
          directory: session.location?.directory,
          status: "open",
          updatedAt: Number(session.time?.updated ?? session.time?.created) || updatedAt,
        });
      } catch (error) {
        log(`session hydrate failed id=${sessionId} error=${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const handleEvent = async (event: any) => {
      const sessionId = event?.data?.sessionID;
      if (event?.type === "tui.session.select" && typeof sessionId === "string") {
        selectedSessionId = sessionId;
        await hydrateSession(sessionId, Number(event.created) || Date.now());
        return;
      }
      if (event?.type === "session.created" && typeof sessionId === "string") {
        sessions.set(sessionId, {
          id: sessionId,
          title: event.data.title || event.data.slug || `Session ${sessionId.slice(0, 8)}`,
          directory: event.data.location?.directory,
          status: "open",
          updatedAt: Number(event.created) || Date.now(),
        });
        return;
      }
      if (event?.type === "session.renamed" && typeof sessionId === "string") {
        const session = sessions.get(sessionId);
        if (session) sessions.set(sessionId, { ...session, title: event.data.title, updatedAt: Number(event.created) || Date.now() });
        return;
      }
      if (event?.type === "session.moved" && typeof sessionId === "string") {
        const session = sessions.get(sessionId);
        if (session) sessions.set(sessionId, { ...session, directory: event.data.location?.directory, updatedAt: Number(event.created) || Date.now() });
        return;
      }
      if (event?.type === "session.deleted" && typeof sessionId === "string") {
        sessions.delete(sessionId);
        for (const [tabId, claim] of claims) {
          if (claim.sessionId === sessionId) claims.delete(tabId);
        }
        if (selectedSessionId === sessionId) selectedSessionId = null;
      }
    };
    const closeEventIterator = async (iterator: AsyncIterator<any> | null) => {
      if (!iterator?.return) return;
      await Promise.race([
        iterator.return(),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    };
    const eventTask = (async () => {
      while (!stopping) {
        const iterator = ctx.event.subscribe()[Symbol.asyncIterator]();
        try {
          while (!stopping) {
            const next = await Promise.race([
              iterator.next(),
              stopped.then((): IteratorResult<any> => ({ done: true, value: undefined })),
            ]);
            if (next.done) break;
            await handleEvent(next.value);
          }
        } catch (error) {
          if (!stopping) log(`event stream stopped error=${error instanceof Error ? error.message : String(error)}`);
        } finally {
          await closeEventIterator(iterator);
        }
        if (!stopping) {
          await Promise.race([
            new Promise<void>((resolve) => setTimeout(resolve, eventRetryMs)),
            stopped,
          ]);
        }
      }
    })();

    return async () => {
      stopping = true;
      stopEvents();
      const activeServer = server;
      server = null;
      const results = await Promise.allSettled([
        eventTask,
        activeServer?.listening
          ? new Promise<void>((resolve, reject) => activeServer.close((error) => error ? reject(error) : resolve()))
          : Promise.resolve(),
        toolRegistration.dispose(),
      ]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    };
  },
});

export default plugin;
