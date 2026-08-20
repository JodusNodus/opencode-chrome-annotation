import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import plugin from "./plugin";

const cleanups: Array<() => Promise<void> | void> = [];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

class EventQueue implements AsyncIterator<any>, AsyncIterable<any> {
  private events: any[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<any>) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<any>> {
    if (this.failure) return Promise.reject(this.failure);
    const event = this.events.shift();
    if (event) return Promise.resolve({ done: false, value: event });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  push(event: any) {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event });
    else this.events.push(event);
  }

  fail(error: Error) {
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async return(): Promise<IteratorResult<any>> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
    return { done: true, value: undefined };
  }
}

function createContext(port: number, portEnd = port) {
  const events = new EventQueue();
  const reconnectedEvents = new EventQueue();
  const eventState = { subscriptions: 0 };
  const prompts: any[] = [];
  const tools: any[] = [];
  const toolState = { disposed: false };
  const sessionInfos = new Map<string, any>();
  const context = {
    app: { name: "opencode", version: "test", channel: "test" },
    options: {
      portStart: port,
      portEnd,
      eventRetryMs: 1,
      allowedExtensionOrigins: ["chrome-extension://test-extension"],
    },
    event: {
      subscribe: () => eventState.subscriptions++ === 0 ? events : reconnectedEvents,
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessionInfos.get(sessionID);
        if (!session) throw new Error("session not found");
        return session;
      },
      prompt: async (input: any) => {
        prompts.push(input);
        return { id: "msg_test", sessionID: input.sessionID };
      },
    },
    tool: {
      transform: async (transform: (draft: { add(tool: any): void }) => void) => {
        transform({ add: (tool) => tools.push(tool) });
        return { dispose: async () => { toolState.disposed = true; } };
      },
    },
  };
  return { context, events, eventState, prompts, reconnectedEvents, sessionInfos, tools, toolState };
}

async function getSessions(port: number) {
  return await fetch(`http://127.0.0.1:${port}/sessions`).then((response) => response.json());
}

async function post(port: number, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "chrome-extension://test-extension" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function postChunks(port: number, path: string, chunks: Buffer[]) {
  return await new Promise<{ status: number | undefined; body: any }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { "content-type": "application/json", origin: "chrome-extension://test-extension" },
    }, (response) => {
      const body: Buffer[] = [];
      response.on("data", (chunk) => body.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(body).toString("utf8")),
      }));
    });
    request.on("error", reject);
    const write = (index: number) => {
      if (index === chunks.length) {
        request.end();
        return;
      }
      request.write(chunks[index]);
      setTimeout(() => write(index + 1), 5);
    };
    write(0);
  });
}

async function expectSessions(port: number, expected: unknown) {
  const deadline = Date.now() + 1_000;
  let actual: unknown;
  while (Date.now() < deadline) {
    actual = await getSessions(port);
    try {
      expect(actual).toEqual(expected);
      return;
    } catch {
      await Bun.sleep(10);
    }
  }
  expect(actual).toEqual(expected);
}

afterEach(async () => {
  setSystemTime();
  while (cleanups.length) await cleanups.pop()?.();
});

describe("OpenCode V2 plugin", () => {
  test("exports the V2 plugin lifecycle", () => {
    expect(plugin.id).toBe("opencode.chrome-annotation");
    expect(typeof plugin.setup).toBe("function");
  });

  test("serves status and an honest empty session list", async () => {
    const port = await freePort();
    const { context, tools } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);

    const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
    const sessions = await fetch(`http://127.0.0.1:${port}/sessions`).then((response) => response.json());

    expect(status.app).toBe("opencode-chrome-annotation");
    expect(status.server).toEqual(expect.objectContaining({ status: "listening", port }));
    expect(sessions).toEqual({ sessions: [] });
    expect(tools.map((tool) => tool.name)).toEqual(["chrome_status"]);
    expect(JSON.parse((await tools[0].execute({})).content).server.port).toBe(port);
  });

  test("tracks real sessions through V2 lifecycle events", async () => {
    const port = await freePort();
    const { context, events } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);

    events.push({
      type: "session.created",
      created: 10,
      data: {
        sessionID: "ses_test",
        slug: "test-session",
        title: "Original title",
        location: { directory: "/workspace" },
      },
    });
    await expectSessions(port, {
      sessions: [{ id: "ses_test", title: "Original title", directory: "/workspace", status: "open" }],
    });

    events.push({ type: "session.renamed", created: 20, data: { sessionID: "ses_test", title: "Renamed" } });
    await expectSessions(port, {
      sessions: [{ id: "ses_test", title: "Renamed", directory: "/workspace", status: "open" }],
    });

    await post(port, "/claim", { tabId: 5, sessionId: "ses_test" });
    events.push({ type: "session.deleted", created: 30, data: { sessionID: "ses_test" } });
    await expectSessions(port, { sessions: [] });
    const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
    expect(status.claims).toEqual([]);
  });

  test("reconnects after a transient event stream failure", async () => {
    const port = await freePort();
    const { context, events, eventState, reconnectedEvents } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);

    events.fail(new Error("temporary stream failure"));
    const deadline = Date.now() + 1_000;
    while (eventState.subscriptions < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(eventState.subscriptions).toBeGreaterThanOrEqual(2);
    reconnectedEvents.push({
      type: "session.created",
      created: 10,
      data: { sessionID: "ses_reconnected", slug: "reconnected", location: { directory: "/workspace" } },
    });

    await expectSessions(port, {
      sessions: [{ id: "ses_reconnected", title: "reconnected", directory: "/workspace", status: "open" }],
    });
  });

  test("hydrates an existing session when the TUI selects it", async () => {
    const port = await freePort();
    const { context, events, sessionInfos } = createContext(port);
    sessionInfos.set("ses_existing", {
      id: "ses_existing",
      title: "Existing session",
      location: { directory: "/existing/project" },
      time: { updated: 42 },
    });
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);

    events.push({ type: "tui.session.select", created: 50, data: { sessionID: "ses_existing" } });

    await expectSessions(port, {
      sessions: [{ id: "ses_existing", title: "Existing session", directory: "/existing/project", status: "open" }],
    });
    const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
    expect(status.opencodeSessionId).toBe("ses_existing");
  });

  test("queues the screenshot without starting code changes", async () => {
    const port = await freePort();
    const { context, events, prompts } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);
    events.push({
      type: "session.created",
      created: 10,
      data: { sessionID: "ses_target", slug: "target", title: "Target", location: { directory: "/workspace" } },
    });
    await expectSessions(port, {
      sessions: [{ id: "ses_target", title: "Target", directory: "/workspace", status: "open" }],
    });

    expect((await post(port, "/claim", { tabId: 7, sessionId: "ses_target", extensionVersion: "1.0.1" })).body)
      .toEqual({ ok: true, sessionId: "ses_target" });

    const screenshot = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const annotation = {
      comment: "Make this heading blue",
      page: { title: "Example", url: "http://localhost:3000/example" },
      element: {
        selector: "main > h1",
        tag: "h1",
        role: "heading",
        text: "Welcome",
        ariaLabel: "Welcome heading",
        rect: { x: 10, y: 20, width: 200, height: 40 },
      },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
      screenshot: { mime: "image/png", dataUrl: screenshot },
    };
    expect((await post(port, "/annotation", { tabId: 7, sessionId: "ses_target", annotation })).body)
      .toEqual({ ok: true, sessionId: "ses_target", queued: true });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual(expect.objectContaining({
      sessionID: "ses_target",
      delivery: "queue",
      resume: false,
      files: [{
        uri: screenshot,
        name: "browser-annotation.png",
        description: "Visible browser tab for the selected element",
      }],
    }));
    expect(prompts[0].text).toContain("Make this heading blue");
    expect(prompts[0].text).toContain("Selector: main > h1");

    expect((await post(port, "/unclaim", { tabId: 7, extensionVersion: "1.0.1" })).body).toEqual({ ok: true });
    const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
    expect(status.claims).toEqual([]);
    expect(status.lastAnnotation).toEqual(expect.objectContaining({ ok: true, sessionId: "ses_target" }));
    expect(status.lastAnnotation.response).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(screenshot.slice("data:image/png;base64,".length));
  });

  test("preserves Unicode split across request chunks", async () => {
    const port = await freePort();
    const { context, events, prompts } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);
    events.push({
      type: "session.created",
      created: 10,
      data: { sessionID: "ses_unicode", slug: "unicode", location: { directory: "/workspace" } },
    });
    await expectSessions(port, {
      sessions: [{ id: "ses_unicode", title: "unicode", directory: "/workspace", status: "open" }],
    });
    await post(port, "/claim", { tabId: 11, sessionId: "ses_unicode" });
    const payload = Buffer.from(JSON.stringify({
      tabId: 11,
      sessionId: "ses_unicode",
      annotation: { comment: "Move the café 🚀 heading", screenshot: { dataUrl: "data:image/png;base64,AA==" } },
    }));
    const emoji = Buffer.from("🚀");
    const split = payload.indexOf(emoji) + 2;

    const result = await postChunks(port, "/annotation", [payload.subarray(0, split), payload.subarray(split)]);

    expect(result).toEqual({ status: 200, body: { ok: true, sessionId: "ses_unicode", queued: true } });
    expect(prompts[0].text).toContain("Move the café 🚀 heading");
  });

  test("rejects an expired tab claim", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const port = await freePort();
    const { context, events } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);
    events.push({
      type: "session.created",
      created: 10,
      data: { sessionID: "ses_expiry", slug: "expiry", location: { directory: "/workspace" } },
    });
    await expectSessions(port, {
      sessions: [{ id: "ses_expiry", title: "expiry", directory: "/workspace", status: "open" }],
    });
    await post(port, "/claim", { tabId: 12, sessionId: "ses_expiry" });
    setSystemTime(new Date("2026-01-01T00:05:01.000Z"));

    const result = await post(port, "/annotation", {
      tabId: 12,
      sessionId: "ses_expiry",
      annotation: { comment: "Too late", screenshot: { dataUrl: "data:image/png;base64,AA==" } },
    });

    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "tab is not claimed by this session" });
  });

  test("falls back from an occupied port and releases its listener during cleanup", async () => {
    const firstPort = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(firstPort, "127.0.0.1", resolve));
    const secondPort = firstPort + 1;
    const { context, toolState } = createContext(firstPort, secondPort);

    const cleanup = await plugin.setup(context as never);
    expect(cleanup).toBeFunction();
    const status = await fetch(`http://127.0.0.1:${secondPort}/status`).then((response) => response.json());
    expect(status.server.port).toBe(secondPort);
    expect(status.server.bindFailures).toEqual([
      expect.objectContaining({ port: firstPort, code: "EADDRINUSE" }),
    ]);

    await cleanup?.();
    expect(toolState.disposed).toBeTrue();
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    const rebound = createServer();
    await new Promise<void>((resolve) => rebound.listen(secondPort, "127.0.0.1", resolve));
    await new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()));
  });

  test("disposes the tool registration when no bridge port is available", async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    const { context, toolState } = createContext(port);

    await expect(plugin.setup(context as never)).rejects.toThrow("Could not bind");
    expect(toolState.disposed).toBeTrue();

    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  });

  test("rejects requests from ordinary web origins", async () => {
    const port = await freePort();
    const { context } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);

    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: { origin: "https://malicious.example" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "Origin not allowed" });

    const foreignExtension = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: { origin: "chrome-extension://foreign-extension" },
    });
    expect(foreignExtension.status).toBe(403);
  });

  test("rejects attachment URIs that are not supported inline images", async () => {
    const port = await freePort();
    const { context, events, prompts } = createContext(port);
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);
    events.push({
      type: "session.created",
      created: 10,
      data: { sessionID: "ses_uri", slug: "uri", location: { directory: "/workspace" } },
    });
    await expectSessions(port, {
      sessions: [{ id: "ses_uri", title: "uri", directory: "/workspace", status: "open" }],
    });
    await post(port, "/claim", { tabId: 13, sessionId: "ses_uri" });

    for (const dataUrl of ["file:///etc/passwd", "https://example.com/image.png", "data:text/plain;base64,SGVsbG8="]) {
      const result = await post(port, "/annotation", {
        tabId: 13,
        sessionId: "ses_uri",
        annotation: { comment: "Bad attachment", screenshot: { dataUrl } },
      });
      expect(result.response.status).toBe(400);
      expect(result.body).toEqual({ ok: false, error: "screenshot must be a supported base64 image data URL" });
    }
    expect(prompts).toEqual([]);
  });

  test("reports prompt admission failures without claiming success", async () => {
    const port = await freePort();
    const { context, events } = createContext(port);
    context.session.prompt = async () => { throw new Error("session no longer exists"); };
    const cleanup = await plugin.setup(context as never);
    if (cleanup) cleanups.push(cleanup);
    events.push({
      type: "session.created",
      created: 10,
      data: { sessionID: "ses_stale", slug: "stale", location: { directory: "/workspace" } },
    });
    await expectSessions(port, {
      sessions: [{ id: "ses_stale", title: "stale", directory: "/workspace", status: "open" }],
    });
    await post(port, "/claim", { tabId: 9, sessionId: "ses_stale" });

    const result = await post(port, "/annotation", {
      tabId: 9,
      sessionId: "ses_stale",
      annotation: { comment: "Change this", screenshot: { dataUrl: "data:image/png;base64,AA==" } },
    });

    expect(result.response.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "session no longer exists" });
    const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
    expect(status.lastAnnotation).toEqual(expect.objectContaining({
      ok: false,
      sessionId: "ses_stale",
      error: "session no longer exists",
    }));
  });
});
