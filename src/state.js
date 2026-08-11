import { statSync, readFileSync, existsSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { RECORDINGS_DIR, SESSIONS_META } from "./config.js";
import { listSessions } from "./tmux.js";

// Status machine (per design doc):
//   needs-approval 🔴, working 🟢, idle ⚪, dead ✖
// Precedence is ordering, not hierarchy: the most recent signal wins.
// Activity may promote (needs-approval→working, idle→working), never demote.
// Activity is derived EXCLUSIVELY from recording growth (pipe-pane stream) — never
// from the attach WebSocket, so opening the terminal cannot flip 🔴→🟢.

const sessions = new Map(); // id → {id, repo, status, createdAt, lastActivity, lastEventAt, lastLine, recSize}

function loadMeta() {
  if (!existsSync(SESSIONS_META)) return {};
  try { return JSON.parse(readFileSync(SESSIONS_META, "utf8")); } catch { return {}; }
}
function saveMeta() {
  const meta = {};
  for (const [id, s] of sessions) if (s.status !== "dead") {
    meta[id] = { repo: s.repo, claudeSessionId: s.claudeSessionId, createdAt: s.createdAt };
  }
  writeFileSync(SESSIONS_META, JSON.stringify(meta, null, 2));
}

export function registerLaunch(id, repo, claudeSessionId = null) {
  sessions.set(id, {
    id, repo, claudeSessionId, status: "idle", createdAt: Date.now(),
    lastActivity: null, lastEventAt: Date.now(), lastLine: "", recSize: 0,
  });
  saveMeta();
}

export function onHookEvent(id, eventName, payload) {
  const s = sessions.get(id);
  if (!s) return null;
  if (payload?.session_id) s.claudeSessionId = String(payload.session_id);
  if (eventName === "Notification") s.status = "needs-approval";
  else if (eventName === "Stop" || eventName === "SubagentStop") s.status = "idle";
  else return s; // unknown events don't transition
  s.lastEventAt = Date.now();
  const summary = payload?.message || payload?.last_assistant_message;
  if (summary) s.lastLine = String(summary).replace(/\s+/g, " ").trim().slice(0, 200);
  saveMeta();
  return s;
}

export function remove(id) {
  sessions.delete(id);
  saveMeta();
}

export function get(id) {
  return sessions.get(id) || null;
}

export function all() {
  const order = { "needs-approval": 0, working: 1, idle: 2, dead: 3 };
  return [...sessions.values()]
    .map(({ recSize, ...pub }) => pub)
    .sort((a, b) => order[a.status] - order[b.status] || b.createdAt - a.createdAt);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*(\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;

function lastRecordedLine(recFile, size) {
  // Read the tail of the jsonl, decode the last chunks, return last non-empty text line.
  try {
    const fd = openSync(recFile, "r");
    const start = Math.max(0, size - 4096);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const text = Buffer.from(JSON.parse(lines[i]).d, "base64").toString("utf8")
          .replace(ANSI_RE, "").trimEnd();
        const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
        if (last) return last.slice(0, 200);
      } catch { /* partial line at tail — skip */ }
    }
  } catch { /* no recording yet */ }
  return null;
}

async function poll() {
  // 1) Reconcile with tmux ls — adopt unknown p23-* sessions (pre-restart), mark gone ones dead.
  let live;
  try { live = await listSessions(); } catch { live = []; }
  const liveIds = new Set(live.map((s) => s.id));
  const meta = loadMeta();
  for (const { id, createdAt } of live) {
    if (!sessions.has(id)) {
      const rec = join(RECORDINGS_DIR, `${id}.jsonl`);
      const recSize = existsSync(rec) ? statSync(rec).size : 0;
      sessions.set(id, {
        id, repo: meta[id]?.repo || "(unknown)", claudeSessionId: meta[id]?.claudeSessionId || null,
        status: "idle", createdAt: meta[id]?.createdAt || createdAt,
        lastActivity: null, lastEventAt: 0, lastLine: lastRecordedLine(rec, recSize) || "", recSize,
      });
    }
  }
  for (const s of sessions.values()) {
    if (!liveIds.has(s.id) && s.status !== "dead") {
      s.status = "dead";
      const rec = join(RECORDINGS_DIR, `${s.id}.jsonl`);
      s.lastLine = lastRecordedLine(rec, existsSync(rec) ? statSync(rec).size : 0) || "(no output)";
      saveMeta();
    }
  }
  // 2) Activity from recording growth (promote-only).
  for (const s of sessions.values()) {
    if (s.status === "dead") continue;
    const rec = join(RECORDINGS_DIR, `${s.id}.jsonl`);
    if (!existsSync(rec)) continue;
    const size = statSync(rec).size;
    if (size > s.recSize) {
      s.recSize = size;
      s.lastActivity = Date.now();
      const line = lastRecordedLine(rec, size);
      if (line) s.lastLine = line;
      // Most recent signal wins: growth after the last hook event promotes.
      if ((s.status === "needs-approval" || s.status === "idle") && s.lastActivity > s.lastEventAt) {
        s.status = "working";
      }
    }
  }
}

export function startPolling(intervalMs = 1000) {
  poll().catch(() => {});
  const t = setInterval(() => poll().catch((e) => console.error("[state] poll:", e.message)), intervalMs);
  t.unref();
}

export function repoLabel(s) {
  return s.repo && s.repo !== "(unknown)" ? basename(s.repo) : s.id;
}
