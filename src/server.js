import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import pty from "node-pty";
import { CONFIG, REPO_ROOT } from "./config.js";
import * as tmuxMod from "./tmux.js";
import * as state from "./state.js";
import * as push from "./push.js";
import * as history from "./history.js";
import { parseArgString } from "./args.js";

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

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
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

async function nextId(repo) {
  const slug = slugify(basename(repo));
  const taken = new Set((await listSessions()).map((s) => s.id));
  for (const s of state.all()) taken.add(s.id);
  for (let n = 1; n < 1000; n++) {
    const id = `p23-${slug}-${String(n).padStart(3, "0")}`;
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

let claudeAvailable = null;
function claudeOnPath() {
  if (claudeAvailable === null) {
    try { execFileSync("which", [CONFIG.claudeBin.split(" ")[0]], { stdio: "pipe" }); claudeAvailable = true; }
    catch { claudeAvailable = false; }
  }
  return claudeAvailable;
}

// ---------- HTTP ----------

const server = createServer(async (req, res) => {
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

  if (path === "/api/sessions" && method === "GET") return json(res, 200, { sessions: state.all() });

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
    try { parsedArgs = parseArgString(body.extraArgs || ""); }
    catch (error) { return json(res, 400, { error: error.message }); }
    if (parsedArgs.some((arg) => ["--resume", "-r", "--continue", "-c", "--session-id"].includes(arg))) {
      return json(res, 400, { error: "Use the History tab to resume Claude sessions" });
    }
    if (!claudeOnPath()) return json(res, 500, { error: `'${CONFIG.claudeBin}' not found on PATH` });
    if (resumeSessionId && state.all().some((session) =>
      session.status !== "dead" && session.claudeSessionId === resumeSessionId,
    )) {
      return json(res, 409, { error: "That Claude session is already running" });
    }
    const id = await nextId(repo);
    const claudeSessionId = resumeSessionId || randomUUID();
    await newSession(id, repo, prompt, parsedArgs, { claudeSessionId, resumeSessionId });
    state.registerLaunch(id, repo, claudeSessionId);
    return json(res, 201, { id, claudeSessionId, resumed: Boolean(resumeSessionId) });
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && method === "DELETE") {
    const id = sessionMatch[1];
    if (!SESSION_ID_RE.test(id)) return json(res, 400, { error: "bad session id" });
    await killSession(id);
    state.remove(id);
    return json(res, 200, { ok: true });
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
        push.sendToAll({ title: `🔴 ${label} — needs attention`, body: payload.message || "Claude is waiting on you", url: `/sessions/${sessionId}` }).catch(() => {});
      } else if (eventName === "Stop") {
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
  if (!m || !SESSION_ID_RE.test(m[1])) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, m[1]));
});

async function attachPty(ws, id) {
  if (!(await hasSession(id))) { ws.close(4404, "no such session"); return; }
  const view = viewSessionName(id);
  // Grouped session: own client size (window-size latest), self-destroys when unattached.
  const p = pty.spawn("tmux", ["new-session", "-t", `=${id}`, "-s", view, ";", "set-option", "destroy-unattached", "on"], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.env.HOME || homedir(), env: process.env,
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
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ---------- start ----------

state.startPolling(1000);
server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`[zumod] listening on http://127.0.0.1:${CONFIG.port} (front with: tailscale serve --bg ${CONFIG.port})`);
});
