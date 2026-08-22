import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ACTIONS_FILE } from "./config.js";

let items = [];
if (existsSync(ACTIONS_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(ACTIONS_FILE, "utf8"));
    if (Array.isArray(saved)) items = saved;
  } catch { /* a broken optional inbox must never stop the daemon */ }
}

function save() {
  const temporary = `${ACTIONS_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, ACTIONS_FILE);
}

export function add({
  sessionId, agent, repo, kind, title, detail = "", dedupeKey = null,
  requestId = null, requestMethod = null,
}) {
  if (!sessionId || !["approval", "question", "failed", "completed"].includes(kind)) {
    throw new Error("invalid action");
  }
  if (dedupeKey) {
    const existing = items.find((item) => !item.resolvedAt && item.dedupeKey === dedupeKey);
    if (existing) return existing;
  }
  const action = {
    id: randomUUID(), sessionId, agent: agent || "claude", repo: repo || "(unknown)",
    kind, title: String(title).slice(0, 160), detail: String(detail).slice(0, 1000),
    createdAt: Date.now(), resolvedAt: null, dedupeKey, requestId, requestMethod,
  };
  items.unshift(action);
  items = items.slice(0, 200);
  save();
  return action;
}

export function all() {
  return items
    .filter((item) => !item.resolvedAt)
    .map(({ dedupeKey, ...item }) => item)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function resolve(id) {
  const item = items.find((candidate) => candidate.id === id && !candidate.resolvedAt);
  if (!item) return false;
  item.resolvedAt = Date.now();
  save();
  return true;
}

export function get(id) {
  const item = items.find((candidate) => candidate.id === id && !candidate.resolvedAt);
  return item ? { ...item } : null;
}

export function resolveRequest(sessionId, requestId) {
  const item = items.find((candidate) =>
    candidate.sessionId === sessionId && String(candidate.requestId) === String(requestId) && !candidate.resolvedAt,
  );
  return item ? resolve(item.id) : false;
}

export function resolveSession(sessionId) {
  let changed = false;
  for (const item of items) {
    if (item.sessionId === sessionId && !item.resolvedAt) {
      item.resolvedAt = Date.now();
      changed = true;
    }
  }
  if (changed) save();
}

export function classifyEnd(lastLine) {
  return /(?:error|failed|exception|unauthorized|denied)/i.test(String(lastLine || "")) ? "failed" : "completed";
}
