import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";
import { CONFIG, REPO_ROOT, UPLOADS_DIR } from "./config.js";
import * as tmuxMod from "./tmux.js";
import * as state from "./state.js";
import * as push from "./push.js";
import * as history from "./history.js";
import * as actions from "./actions.js";
import * as codexDriver from "./codex-driver.js";
import * as relay from "./relay.js";
import { AGENTS, validateAgentArgs } from "./args.js";
import { buildHandoffPrompt, buildReviewPrompt, repositorySnapshot } from "./handoff.js";

const { SESSION_ID_RE, listSessions, hasSession, newSession, killSession, viewSessionName, destroyView } = tmuxMod;

const PUBLIC_DIR = join(REPO_ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const VENDOR_FILES = new Map([
  ["/vendor/xterm.mjs", join(REPO_ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.mjs")],
  ["/vendor/addon-fit.mjs", join(REPO_ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.mjs")],
  ["/vendor/xterm.css", join(REPO_ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css")],
]);
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    const error = new Error("request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
}

// Reject anything that isn't a real image before writing it to disk (magic-byte check).
function looksLikeImage(b) {
  if (b.length < 12) return false;
  if (b.subarray(0, 4).toString("hex") === "89504e47") return true; // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG
  if (b.subarray(0, 3).toString("ascii") === "GIF") return true; // GIF
  if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return true; // WEBP
  return false;
}

async function nextId(repo, agent) {
  const slug = slugify(basename(repo));
  const taken = new Set((await listSessions()).map((s) => s.id));
  for (const s of state.all()) taken.add(s.id);
  for (let n = 1; n < 1000; n++) {
    const id = `p23-${agent}-${slug}-${String(n).padStart(3, "0")}`;
    if (!taken.has(id)) return id;
  }
  throw new Error("no free session id");
}

function scanRepos() {
  const repos = [];
  for (const root of CONFIG.repoRoots) {
    if (!existsSync(root)) continue;
    const walk = (dir, depth) => {
      if (depth > 3 || repos.length > 200) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (entries.some((e) => e.name === ".git")) { repos.push(dir); return; }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") walk(join(dir, e.name), depth + 1);
      }
    };
    walk(root, 0);
  }
  return repos.sort();
}

const agentAvailability = new Map();
function agentOnPath(agent) {
  if (!agentAvailability.has(agent)) {
    try { execFileSync("which", [CONFIG.agentBins[agent]], { stdio: "pipe" }); agentAvailability.set(agent, true); }
    catch { agentAvailability.set(agent, false); }
  }
  return agentAvailability.get(agent);
}

async function launchManaged({
  agent, repo, prompt, extraArgs = [], structured = agent === "codex",
  resumeSessionId = null, purpose = "work", parentSessionId = null, sandbox = "workspace-write",
}) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`Unsupported agent: ${agent}`);
  if (!agentOnPath(agent)) throw new Error(`'${CONFIG.agentBins[agent]}' not found on PATH`);
  const id = await nextId(repo, agent);
  const transport = agent === "codex" && structured ? "structured" : "pty";
  if (transport === "structured") {
    state.registerLaunch(id, repo, { agent, transport, purpose, parentSessionId });
    try {
      const nativeSessionId = await codexDriver.launch({ id, repo, prompt, extraArgs, sandbox, purpose });
      return { id, agent, transport, nativeSessionId, resumed: false };
    } catch (error) {
      state.remove(id);
      throw error;
    }
  }
  const nativeSessionId = resumeSessionId || (["claude", "pi"].includes(agent) ? randomUUID() : null);
  await newSession(id, { repo, prompt, extraArgs, agent, nativeSessionId, resumeSessionId });
  state.registerLaunch(id, repo, { agent, transport, purpose, parentSessionId, nativeSessionId });
  return {
    id, agent, transport, nativeSessionId,
    claudeSessionId: agent === "claude" ? nativeSessionId : null,
    resumed: Boolean(resumeSessionId),
  };
}

// ---------- HTTP ----------

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  try {
    if (path.startsWith("/api/")) return await api(req, res, url);
    return serveStatic(req, res, path);
  } catch (e) {
    console.error(`[http] ${req.method} ${path}:`, e.message);
    if (!res.headersSent) json(res, e.statusCode || 500, { error: e.message });
  }
});

async function api(req, res, url) {
  const path = url.pathname;
  const method = req.method;
  if (!["GET", "HEAD"].includes(method) && !sameOrigin(req)) {
    return json(res, 403, { error: "cross-origin request rejected" });
  }

  if (path === "/api/sessions" && method === "GET") return json(res, 200, { sessions: state.all() });

  if (path === "/api/actions" && method === "GET") return json(res, 200, { actions: actions.all() });

  if (path === "/api/relay" && method === "GET") return json(res, 200, relay.status());
  if (path === "/api/relay/pair" && method === "POST") {
    return relay.rotatePairing()
      ? json(res, 200, relay.status())
      : json(res, 503, { error: "AWS relay is not configured" });
  }

  const actionMatch = path.match(/^\/api\/actions\/([^/]+)$/);
  if (actionMatch && method === "DELETE") {
    return actions.resolve(actionMatch[1])
      ? json(res, 200, { ok: true })
      : json(res, 404, { error: "action not found" });
  }

  const actionResponseMatch = path.match(/^\/api\/actions\/([^/]+)\/respond$/);
  if (actionResponseMatch && method === "POST") {
    const action = actions.get(actionResponseMatch[1]);
    if (!action) return json(res, 404, { error: "action not found" });
    const body = await readJson(req);
    try { codexDriver.respond(action.sessionId, action.requestId, String(body.decision || "")); }
    catch (error) { return json(res, 409, { error: error.message }); }
    actions.resolve(action.id);
    return json(res, 200, { ok: true });
  }

  if (path === "/api/agents" && method === "GET") {
    const agents = Object.entries(AGENTS).map(([id, agent]) => ({
      id, label: agent.label, available: agentOnPath(id),
    }));
    return json(res, 200, { agents });
  }

  if (path === "/api/history" && method === "GET") {
    const activeIds = new Set(
      state.all()
        .filter((session) => session.status !== "dead")
        .map((session) => session.claudeSessionId)
        .filter(Boolean),
    );
    const sessions = history.listHistory({
      limit: url.searchParams.get("limit") || 100,
      query: url.searchParams.get("q") || "",
    }).map((session) => ({ ...session, active: activeIds.has(session.sessionId) }));
    return json(res, 200, { sessions });
  }

  if (path === "/api/sessions" && method === "POST") {
    const body = await readJson(req);
    const resumeSessionId = body.resumeSessionId ? String(body.resumeSessionId) : null;
    const agent = resumeSessionId ? "claude" : String(body.agent || "claude");
    if (!Object.hasOwn(AGENTS, agent)) return json(res, 400, { error: `Unsupported agent: ${agent}` });
    const previous = resumeSessionId ? history.getHistorySession(resumeSessionId) : null;
    if (resumeSessionId && (!history.UUID_RE.test(resumeSessionId) || !previous)) {
      return json(res, 404, { error: "Claude session was not found in local history" });
    }
    const repoValue = previous?.project || body.repo;
    const repo = repoValue ? resolve(String(repoValue)) : null;
    const prompt = String(body.prompt || "").trim();
    if (!repo || !existsSync(repo) || !statSync(repo).isDirectory()) return json(res, 400, { error: "repo is not a directory" });
    if (!prompt && !resumeSessionId) return json(res, 400, { error: "prompt is required" });
    if (prompt.length > 100_000) return json(res, 400, { error: "prompt is too long" });
    if (body.extraArgs != null && typeof body.extraArgs !== "string" && !Array.isArray(body.extraArgs)) {
      return json(res, 400, { error: "extraArgs must be a string or array" });
    }
    let parsedArgs;
    try { parsedArgs = validateAgentArgs(agent, body.extraArgs || ""); }
    catch (error) { return json(res, 400, { error: error.message }); }
    if (!agentOnPath(agent)) return json(res, 500, { error: `'${CONFIG.agentBins[agent]}' not found on PATH` });
    if (resumeSessionId && state.all().some((session) =>
      session.status !== "dead" && session.claudeSessionId === resumeSessionId,
    )) {
      return json(res, 409, { error: "That Claude session is already running" });
    }
    const launched = await launchManaged({
      agent, repo, prompt, extraArgs: parsedArgs,
      structured: body.structured !== false, resumeSessionId,
    });
    return json(res, 201, launched);
  }

  const workflowMatch = path.match(/^\/api\/sessions\/([^/]+)\/(handoff|review)$/);
  if (workflowMatch && method === "POST") {
    const source = state.get(workflowMatch[1]);
    if (!source) return json(res, 404, { error: "source session not found" });
    const body = await readJson(req);
    const targetAgent = String(body.agent || (source.agent === "codex" ? "claude" : "codex"));
    if (!Object.hasOwn(AGENTS, targetAgent)) return json(res, 400, { error: `Unsupported agent: ${targetAgent}` });
    if (targetAgent === source.agent) return json(res, 400, { error: "Choose a different harness" });
    if (!agentOnPath(targetAgent)) return json(res, 400, { error: `${AGENTS[targetAgent].label} is not installed` });
    const snapshot = repositorySnapshot(source.repo);
    if (workflowMatch[2] === "review") {
      if (!["claude", "codex"].includes(targetAgent)) {
        return json(res, 400, { error: "Read-only review currently supports Claude Code and Codex" });
      }
      const launched = await launchManaged({
        agent: targetAgent, repo: source.repo, prompt: buildReviewPrompt(source, snapshot),
        extraArgs: targetAgent === "claude" ? ["--permission-mode", "plan"] : [],
        structured: targetAgent === "codex", sandbox: "read-only",
        purpose: "review", parentSessionId: source.id,
      });
      return json(res, 201, launched);
    }
    const launched = await launchManaged({
      agent: targetAgent, repo: source.repo,
      prompt: buildHandoffPrompt(source, targetAgent, snapshot),
      purpose: "handoff", parentSessionId: source.id,
    });
    return json(res, 201, launched);
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "DELETE") {
    const id = sessionMatch[1];
    if (!SESSION_ID_RE.test(id)) return json(res, 400, { error: "bad session id" });
    const session = state.get(id);
    if (session?.transport === "structured") codexDriver.stop(id);
    else await killSession(id);
    actions.resolveSession(id);
    state.remove(id);
    return json(res, 200, { ok: true });
  }

  const eventsMatch = path.match(/^\/api\/sessions\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    const payload = codexDriver.events(eventsMatch[1], Math.max(0, Number(url.searchParams.get("since")) || 0));
    return payload ? json(res, 200, payload) : json(res, 404, { error: "structured session not found" });
  }

  const messagesMatch = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messagesMatch && method === "POST") {
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) return json(res, 400, { error: "message is required" });
    if (message.length > 100_000) return json(res, 400, { error: "message is too long" });
    try { await codexDriver.sendMessage(messagesMatch[1], message); }
    catch (error) { return json(res, 409, { error: error.message }); }
    return json(res, 202, { ok: true });
  }

  const imageMatch = path.match(/^\/api\/sessions\/([^/]+)\/image$/);
  if (imageMatch && method === "POST") {
    const id = imageMatch[1];
    if (!SESSION_ID_RE.test(id)) return json(res, 400, { error: "bad session id" });
    if (!(await hasSession(id))) return json(res, 404, { error: "no such session" });
    let payload;
    try { payload = JSON.parse((await readBody(req, 16 * 1024 * 1024)) || "{}"); }
    catch { return json(res, 400, { error: "request body must be valid JSON" }); }
    const EXT = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp" };
    const ext = EXT[String(payload.ext || "").toLowerCase()];
    if (!ext) return json(res, 400, { error: "unsupported image type" });
    let buf;
    try { buf = Buffer.from(String(payload.data || ""), "base64"); }
    catch { return json(res, 400, { error: "invalid image data" }); }
    if (!buf.length) return json(res, 400, { error: "empty image" });
    if (buf.length > 12 * 1024 * 1024) return json(res, 413, { error: "image too large (max 12 MB)" });
    if (!looksLikeImage(buf)) return json(res, 400, { error: "data is not a recognised image" });
    const file = join(UPLOADS_DIR, `${id}-${randomUUID()}.${ext}`);
    try { writeFileSync(file, buf, { mode: 0o600 }); }
    catch (e) { return json(res, 500, { error: `could not save image: ${e.message}` }); }
    return json(res, 201, { path: file });
  }

  if (path === "/api/repos" && method === "GET") return json(res, 200, { repos: scanRepos() });

  if (path === "/api/push/vapid" && method === "GET") {
    const key = push.vapidPublicKey();
    return key ? json(res, 200, { publicKey: key }) : json(res, 503, { error: "push not configured" });
  }

  if (path === "/api/push/subscribe" && method === "POST") {
    const sub = await readJson(req);
    const count = push.addSubscription(sub);
    return json(res, 201, { subscriptions: count });
  }

  if (path === "/api/events" && method === "POST") {
    const raw = (await readBody(req)) || "{}";
    let payload = {};
    try { payload = JSON.parse(raw); } catch { /* hooks always send JSON; tolerate garbage */ }
    const eventName = payload.hook_event_name || "unknown"; // single source of truth (not query params)
    const sessionId = url.searchParams.get("session") || "";
    const cwd = payload.cwd || "";

    if (sessionId && SESSION_ID_RE.test(sessionId)) {
      const s = state.onHookEvent(sessionId, eventName, payload);
      const label = s ? state.repoLabel(s) : sessionId;
      if (eventName === "Notification") {
        const kind = /permission|approval/i.test(String(payload.notification_type || payload.message || ""))
          ? "approval" : "question";
        actions.add({
          sessionId, agent: s?.agent, repo: s?.repo, kind,
          title: kind === "approval" ? "Approval required" : "Claude needs attention",
          detail: payload.message || "Claude is waiting on you",
          dedupeKey: `${sessionId}:notification:${payload.notification_type || "attention"}:${payload.message || ""}`,
        });
        push.sendToAll({ title: `🔴 ${label} — needs attention`, body: payload.message || "Claude is waiting on you", url: `/sessions/${sessionId}` }).catch(() => {});
      } else if (eventName === "Stop") {
        actions.resolveSession(sessionId);
        actions.add({
          sessionId, agent: s?.agent, repo: s?.repo, kind: "completed",
          title: s?.purpose === "review" ? "Review ready" : "Turn completed",
          detail: s?.lastLine || "Claude finished this turn",
        });
        push.sendToAll({ title: `✅ ${label} — finished`, body: s?.lastLine || "Turn ended", url: `/sessions/${sessionId}` }).catch(() => {});
      }
    } else {
      // Unmanaged session (desk-started): notification-only, link to the list.
      const label = cwd ? basename(cwd) : "claude";
      if (eventName === "Notification") {
        push.sendToAll({ title: `🔴 ${label} — needs attention (desk session)`, body: payload.message || "", url: "/" }).catch(() => {});
      } else if (eventName === "Stop") {
        push.sendToAll({ title: `✅ ${label} — finished (desk session)`, body: "", url: "/" }).catch(() => {});
      }
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "not found" });
}

function serveStatic(req, res, path) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("method not allowed");
    return;
  }
  if (path === "/" || path.startsWith("/sessions/")) path = "/index.html"; // SPA routes
  const file = VENDOR_FILES.get(path) || resolve(PUBLIC_DIR, `.${path}`);
  const insidePublic = !isAbsolute(relative(PUBLIC_DIR, file)) && !relative(PUBLIC_DIR, file).startsWith("..");
  if ((!insidePublic && !VENDOR_FILES.has(path)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": path.startsWith("/vendor/") ? "public, max-age=86400" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// ---------- WebSocket PTY bridge ----------

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const m = req.url?.match(/^\/api\/sessions\/([^/?]+)\/pty(?:\?.*)?$/);
  if (!m || !SESSION_ID_RE.test(m[1]) || !sameOrigin(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, m[1]));
});

async function attachPty(ws, id) {
  const view = viewSessionName(id);
  // Grouped session: own client size (window-size latest), self-destroys when unattached.
  const p = pty.spawn("tmux", ["new-session", "-t", `=${id}`, "-s", view, ";", "set-option", "destroy-unattached", "on"], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.env.HOME || homedir(), env: process.env,
  });
  // The browser can send its initial size as soon as the WebSocket opens. Bind before
  // the first await or that one resize frame is lost and tmux stays at its 80x24 default.
  ws.on("message", (data) => {
    try {
      if (data.length > 64 * 1024) return;
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.type === "input" && typeof msg.data === "string") p.write(msg.data.slice(0, 16_384));
      else if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols > 0 && msg.rows > 0) {
        p.resize(Math.min(msg.cols, 500), Math.min(msg.rows, 200));
      }
    } catch { /* ignore malformed frames */ }
  });
  // Close the check-then-attach race: if the base was killed while this grouped view was
  // being spawned, the view would keep the shared window (and Claude) alive after a Kill.
  // Tear it down immediately so kills always stick and reconnects can't land on a dead base.
  if (!(await hasSession(id))) {
    try { p.kill(); } catch {}
    void destroyView(view);
    ws.close(4404, "no such session");
    return;
  }
  let closed = false;
  let baseWatch;
  let heartbeat;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(baseWatch);
    clearInterval(heartbeat);
    try { p.kill(); } catch {}
    void destroyView(view); // belt + braces with destroy-unattached
  };
  baseWatch = setInterval(async () => {
    if (closed || await hasSession(id)) return;
    cleanup();
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "session ended");
  }, 1000);
  baseWatch.unref();
  // Keepalive: an idle Claude produces no output, so without periodic ping frames the
  // mobile carrier NAT / tailscale proxy drops the silent TCP connection (~30-60s) and the
  // phone sees a "connection reset". Ping every 20s to keep the path warm; browsers auto-pong.
  // A client that misses two consecutive pongs is dead — terminate so the phone reconnects
  // cleanly instead of streaming into a black hole.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} cleanup(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }, 20_000);
  heartbeat.unref();
  p.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(d, "utf8"), { binary: true }); });
  p.onExit(() => { cleanup(); if (ws.readyState === WebSocket.OPEN) ws.close(1000, "session ended"); });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ---------- start ----------

state.startPolling(1000);
relay.start({
  snapshot: () => {
    const sessionItems = state.all().filter((session) => session.status !== "dead");
    const actionItems = actions.all();
    return {
      sessionTotal: sessionItems.length,
      actionTotal: actionItems.length,
      sessions: sessionItems.slice(0, 20).map((session) => ({
        id: session.id, agent: session.agent, transport: session.transport, purpose: session.purpose,
        status: session.status, repo: state.repoLabel(session), createdAt: session.createdAt,
        lastActivity: session.lastActivity || session.lastEventAt,
      })),
      actions: actionItems.slice(0, 15).map((action) => ({
        id: action.id, sessionId: action.sessionId, agent: action.agent,
        repo: basename(action.repo), kind: action.kind, title: action.title,
        detail: ["approval", "question", "failed"].includes(action.kind) ? action.detail.slice(0, 500) : "",
        createdAt: action.createdAt, requestId: action.requestId,
      })),
    };
  },
  onCommand: async (command) => {
    if (command.action === "refresh") return { ok: true };
    if (command.action === "dismiss") return { ok: actions.resolve(String(command.actionId || "")) };
    if (command.action === "respond") {
      const action = actions.get(String(command.actionId || ""));
      if (!action) throw new Error("action not found");
      codexDriver.respond(action.sessionId, action.requestId, String(command.decision || ""));
      return { ok: true };
    }
    if (command.action === "answer") {
      const action = actions.get(String(command.actionId || ""));
      const answer = String(command.answer || "").trim();
      if (!action || action.kind !== "question") throw new Error("question not found");
      if (!answer || answer.length > 5_000) throw new Error("answer must be 1–5000 characters");
      await codexDriver.sendMessage(action.sessionId, answer);
      return { ok: true };
    }
    if (command.action === "kill") {
      const session = state.get(String(command.sessionId || ""));
      if (!session) throw new Error("session not found");
      if (session.transport === "structured") codexDriver.stop(session.id);
      else await killSession(session.id);
      actions.resolveSession(session.id);
      state.remove(session.id);
      return { ok: true };
    }
    throw new Error("unsupported relay command");
  },
});
server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`[zumod] listening on http://127.0.0.1:${CONFIG.port} (front with: tailscale serve --bg ${CONFIG.port})`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    relay.stop();
    codexDriver.stopAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
