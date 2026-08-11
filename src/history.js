import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const HISTORY_FILE = join(CLAUDE_HOME, "history.jsonl");
const PROJECTS_DIR = join(CLAUDE_HOME, "projects");

let cacheKey = "";
let cachedSessions = [];
let cachedById = new Map();

function transcriptSessionIds() {
  const ids = new Set();
  if (!existsSync(PROJECTS_DIR)) return ids;
  let projects = [];
  try { projects = readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return ids; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let files = [];
    try { files = readdirSync(join(PROJECTS_DIR, project.name), { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const id = file.name.slice(0, -6);
      if (UUID_RE.test(id)) ids.add(id);
    }
  }
  return ids;
}

function cleanPrompt(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 280);
}

function usefulPrompt(value) {
  return value && !value.startsWith("/") && !/^\[Image(?: #[0-9]+)?\]$/i.test(value);
}

export function buildHistory(lines) {
  const sessions = new Map();
  for (const line of lines) {
    if (!line) continue;
    let row;
    try { row = typeof line === "string" ? JSON.parse(line) : line; }
    catch { continue; }
    if (!UUID_RE.test(row?.sessionId || "") || typeof row.project !== "string" || !row.project) continue;
    const timestamp = Number(row.timestamp) || 0;
    const prompt = cleanPrompt(row.display);
    let session = sessions.get(row.sessionId);
    if (!session) {
      session = {
        sessionId: row.sessionId,
        project: row.project,
        repoLabel: basename(row.project),
        title: "Untitled session",
        lastPrompt: "",
        createdAt: timestamp,
        updatedAt: timestamp,
        promptCount: 0,
        available: false,
        _fallbackTitle: "",
      };
      sessions.set(row.sessionId, session);
    }
    if (timestamp && (!session.createdAt || timestamp < session.createdAt)) session.createdAt = timestamp;
    if (timestamp >= session.updatedAt) {
      session.updatedAt = timestamp;
      if (prompt) session.lastPrompt = prompt;
    }
    if (prompt) {
      session.promptCount += 1;
      if (!session._fallbackTitle) session._fallbackTitle = prompt;
      if (session.title === "Untitled session" && usefulPrompt(prompt)) session.title = prompt;
    }
  }

  return [...sessions.values()]
    .map((session) => {
      if (session.title === "Untitled session" && session._fallbackTitle) session.title = session._fallbackTitle;
      session.available = existsSync(session.project);
      delete session._fallbackTitle;
      return session;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function load() {
  if (!existsSync(HISTORY_FILE)) {
    cachedSessions = [];
    cachedById = new Map();
    cacheKey = "missing";
    return;
  }
  const stat = statSync(HISTORY_FILE);
  const nextKey = `${stat.size}:${stat.mtimeMs}`;
  if (cacheKey === nextKey) return;
  const transcriptIds = transcriptSessionIds();
  cachedSessions = buildHistory(readFileSync(HISTORY_FILE, "utf8").split("\n"))
    .map((session) => ({ ...session, available: session.available && transcriptIds.has(session.sessionId) }))
    .filter((session) => session.available);
  cachedById = new Map(cachedSessions.map((session) => [session.sessionId, session]));
  cacheKey = nextKey;
}

export function listHistory({ limit = 100, query = "" } = {}) {
  load();
  const needle = String(query).trim().toLowerCase();
  const filtered = needle
    ? cachedSessions.filter((session) =>
      session.title.toLowerCase().includes(needle)
      || session.lastPrompt.toLowerCase().includes(needle)
      || session.project.toLowerCase().includes(needle),
    )
    : cachedSessions;
  return filtered.slice(0, Math.max(1, Math.min(Number(limit) || 100, 250)));
}

export function getHistorySession(sessionId) {
  load();
  return cachedById.get(sessionId) || null;
}

export { UUID_RE };
