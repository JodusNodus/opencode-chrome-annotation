#!/usr/bin/env node
// claude-bridge.mjs - exposes active Claude Code sessions to the
// opencode-annotate Chrome extension, speaking the same HTTP contract as the
// OpenCode plugin (see src/plugin.ts). Run alongside OpenCode:
//
//   node claude-bridge.mjs
//
// The extension discovers every server on 127.0.0.1:39240-39260 answering
// /status with app "opencode-chrome-annotation", so Claude sessions appear in
// the same side-panel picker without any extension changes.
//
// Sessions come from Claude Code's own registry (~/.claude/sessions/<pid>.json)
// filtered to live processes, so only active chats are ever listed. Delivery
// uses Claude Code's cross-session inbox socket: authenticate with the peer
// token stored next to the registry file, then post the annotation as a user
// message (same prompt text the OpenCode plugin composes).
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const APP_ID = "opencode-chrome-annotation";
const APP_VERSION = "claude-bridge/0.1.0";
const PORT_START = 39240;
const PORT_END = 39260;
const LISTEN_HOST = "127.0.0.1";

const sessionsDir = join(process.env.HOME || "", ".claude", "sessions");
const annotationDir = join(tmpdir(), "claude-code-bridge", "annotations");
const claims = new Map(); // tabId -> { sessionId, extensionVersion }
const log = (...args) => console.error(`[claude-bridge]`, ...args);

function readRegistry() {
  const out = [];
  let files;
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return out;
  }
  for (const file of files) {
    if (!file.endsWith(".json"))
      continue;
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"));
    } catch {
      continue;
    }
    if (!entry?.sessionId || !entry?.messagingSocketPath || !entry?.pid)
      continue; // bare-mode sessions never bind a socket; skip them
    try {
      process.kill(entry.pid, 0); // ESRCH when the process is gone
    } catch {
      continue;
    }
    out.push(entry);
  }
  return out;
}

function readPeerToken(pid) {
  const file = readdirSync(sessionsDir).find((name) => name.startsWith(`${pid}.`) && name.endsWith(".key"));
  if (!file)
    return null;
  try {
    return JSON.parse(readFileSync(join(sessionsDir, file), "utf-8"))?.peerToken || null;
  } catch {
    return null;
  }
}

function listSessions() {
  return readRegistry().map((entry) => ({
    id: entry.sessionId,
    title: entry.name || entry.sessionId,
    directory: entry.cwd || "",
    updatedAt: Number(entry.updatedAt) || Date.now(),
    status: entry.status || "idle",
    agent: "claude-code"
  }));
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match)
    throw new Error("Annotation screenshot must be a base64 data URL");
  return {
    mime: match[1] || "application/octet-stream",
    bytes: Buffer.from(match[2], "base64")
  };
}

function sanitizeFileStem(value) {
  return String(value || "annotation")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "annotation";
}

// Mirrors buildAnnotationPrompt in src/plugin.ts so Claude receives the same
// payload shape OpenCode sessions get.
function buildAnnotationPrompt(annotation) {
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
    "Please inspect the screenshot and selected element metadata, then make the appropriate code change."
  ].join("\n");
}

// Claude Code cross-session inbox protocol: newline-delimited JSON over the
// session's Unix socket. Line 1 authenticates with the session's peer token,
// line 2 delivers the message as a user turn. The wire is silent on success -
// there is no ack - so completing both writes is our success signal.
function deliverToSession(socketPath, token, text) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error) => {
      if (settled)
        return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve();
    };
    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "auth", token }) + "\n");
      socket.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
      socket.end();
    });
    socket.on("error", finish);
    socket.on("close", () => finish());
    setTimeout(() => finish(new Error("Timed out writing to the Claude session socket")), 10000).unref();
  });
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req)
    chunks.push(chunk);
  if (!chunks.length)
    return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function findRegistryEntry(sessionId) {
  return readRegistry().find((entry) => entry.sessionId === sessionId) || null;
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }
  const url = new URL(req.url || "/", `http://${LISTEN_HOST}`);
  try {
    if (req.method === "GET" && url.pathname === "/status") {
      json(res, 200, {
        app: APP_ID,
        agent: "claude-code",
        version: APP_VERSION,
        port: server.address()?.port,
        pid: process.pid
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      json(res, 200, { sessions: listSessions() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/claim") {
      const body = await readJsonBody(req);
      const tabId = body?.tabId;
      const sessionId = body?.sessionId;
      if (!Number.isFinite(tabId))
        throw new Error("tabId is required");
      if (typeof sessionId !== "string" || !sessionId)
        throw new Error("sessionId is required");
      if (!findRegistryEntry(sessionId))
        throw new Error("No active Claude Code session with that id. Open or pick a running chat.");
      claims.set(tabId, { sessionId, extensionVersion: body?.extensionVersion });
      json(res, 200, { ok: true, sessionId });
      return;
    }

    if (req.method === "POST" && url.pathname === "/unclaim") {
      const body = await readJsonBody(req);
      if (Number.isFinite(body?.tabId))
        claims.delete(body.tabId);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/annotation") {
      const body = await readJsonBody(req);
      const tabId = body?.tabId;
      const sessionId = body?.sessionId;
      const annotation = body?.annotation;
      if (!Number.isFinite(tabId))
        throw new Error("tabId is required");
      if (typeof sessionId !== "string" || !sessionId)
        throw new Error("sessionId is required");
      if (!annotation || typeof annotation !== "object")
        throw new Error("annotation is required");

      claims.set(tabId, { sessionId, extensionVersion: body?.extensionVersion });

      let promptText = buildAnnotationPrompt(annotation);
      const screenshot = annotation?.screenshot;
      if (screenshot?.dataUrl) {
        mkdirSync(annotationDir, { recursive: true });
        const { mime, bytes } = decodeDataUrl(screenshot.dataUrl);
        const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
        const stem = sanitizeFileStem(annotation?.page?.title || annotation?.element?.tag || "annotation");
        const filePath = join(annotationDir, `${Date.now()}-${stem}.${ext}`);
        writeFileSync(filePath, bytes);
        promptText += `\n\nScreenshot: ${filePath}`;
      }

      const entry = findRegistryEntry(sessionId);
      if (!entry)
        throw new Error("That Claude Code chat is no longer active. Pick a running chat and try again.");
      const token = readPeerToken(entry.pid);
      if (!token)
        throw new Error("Could not read the Claude session's messaging token");

      await deliverToSession(entry.messagingSocketPath, token, promptText);
      log(`annotation delivered sessionId=${sessionId} tabId=${tabId}`);
      json(res, 200, { ok: true, sessionId, transport: "cross-session-socket" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/session/close") {
      throw new Error("Closing Claude Code chats from the side panel is not supported. Stop the session in your terminal.");
    }

    json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`http error path=${url.pathname} error=${message}`);
    json(res, 400, { ok: false, error: message });
  }
});

for (let port = PORT_START; port <= PORT_END; port++) {
  const bound = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, LISTEN_HOST, () => resolve(true));
  });
  if (bound) {
    log(`listening on ${LISTEN_HOST}:${port}`);
    break;
  }
}
if (!server.listening)
  throw new Error(`All ports ${PORT_START}-${PORT_END} are busy`);
