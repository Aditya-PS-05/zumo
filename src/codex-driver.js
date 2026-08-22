import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { delimiter, dirname } from "node:path";
import { CONFIG } from "./config.js";
import * as actions from "./actions.js";
import * as push from "./push.js";
import * as state from "./state.js";

const sessions = new Map();

function upsert(session, event) {
  const existing = session.events.find((item) => item.id === event.id);
  const revision = ++session.revision;
  if (existing) Object.assign(existing, event, { revision });
  else session.events.push({ createdAt: Date.now(), ...event, revision });
  session.events = session.events.slice(-200);
}

function send(session, message) {
  if (!session.child.stdin.writable) throw new Error("Codex app-server is offline");
  session.child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(session, method, params, timeoutMs = 20_000) {
  const id = session.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(String(id));
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    session.pending.set(String(id), { resolve, reject, timer });
    send(session, { method, id, params });
  });
}

function itemText(item) {
  if (item.type === "agentMessage") return item.text || "";
  if (item.type === "commandExecution") {
    return [Array.isArray(item.command) ? item.command.join(" ") : item.command, item.aggregatedOutput]
      .filter(Boolean).join("\n").slice(0, 20_000);
  }
  if (item.type === "fileChange") {
    return (item.changes || []).map((change) => `${change.kind || "change"}: ${change.path}`).join("\n");
  }
  if (item.type === "mcpToolCall") return `${item.server || "MCP"} / ${item.tool || "tool"}`;
  if (item.type === "webSearch") return item.query || "Web search";
  return item.text || "";
}

function renderItem(session, item) {
  if (!item?.id || item.type === "userMessage" || item.type === "reasoning") return;
  const titles = {
    agentMessage: "Codex", commandExecution: "Command", fileChange: "File changes",
    mcpToolCall: "MCP tool", webSearch: "Web search", plan: "Plan",
  };
  upsert(session, {
    id: item.id, type: item.type === "agentMessage" ? "agent" : "tool",
    title: titles[item.type] || item.type || "Event", text: itemText(item), status: item.status || "",
  });
}

function approvalDetail(params) {
  if (params.networkApprovalContext?.host) {
    return `Allow ${params.networkApprovalContext.protocol || "network"} access to ${params.networkApprovalContext.host}?`;
  }
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  return params.reason || command || params.cwd || "Codex requested permission to continue.";
}

function handleServerRequest(session, message) {
  const requestId = String(message.id);
  const method = message.method;
  session.requests.set(requestId, { id: message.id, method, params: message.params || {} });
  const question = method === "item/tool/requestUserInput";
  const detail = question
    ? (message.params?.questions || []).map((item) => item.question || item.header).filter(Boolean).join("\n")
    : approvalDetail(message.params || {});
  actions.add({
    sessionId: session.id, agent: "codex", repo: session.repo,
    kind: question ? "question" : "approval",
    title: question ? "Codex has a question" : "Approval required",
    detail, requestId, requestMethod: method, dedupeKey: `${session.id}:request:${requestId}`,
  });
  state.update(session.id, {
    status: "needs-approval", lastLine: detail || "Codex needs attention", lastEventAt: Date.now(),
  });
  push.sendToAll({
    title: question ? "❓ Codex has a question" : "🔴 Codex needs approval",
    body: detail, url: "/",
  }).catch(() => {});
}

function finishTurn(session, turn) {
  session.activeTurnId = null;
  const failed = turn?.status === "failed";
  const lastReply = [...session.events].reverse().find((event) => event.type === "agent")?.text;
  const detail = turn?.error?.message || lastReply || (failed ? "Codex turn failed" : "Codex finished this turn");
  state.update(session.id, {
    status: "idle", lastLine: detail.slice(-200), lastActivity: Date.now(), lastEventAt: Date.now(),
  });
  actions.resolveSession(session.id);
  actions.add({
    sessionId: session.id, agent: "codex", repo: session.repo,
    kind: failed ? "failed" : "completed",
    title: session.purpose === "review" ? "Review ready" : failed ? "Codex turn failed" : "Codex turn completed", detail,
  });
  upsert(session, {
    id: `turn-${turn?.id || Date.now()}`, type: failed ? "error" : "status",
    title: failed ? "Failed" : "Completed", text: detail, status: turn?.status || "completed",
  });
  push.sendToAll({
    title: failed ? "❌ Codex turn failed" : "✅ Codex turn finished",
    body: detail, url: `/sessions/${session.id}`,
  }).catch(() => {});
}

function handleNotification(session, message) {
  const params = message.params || {};
  if (message.method === "turn/started") {
    session.activeTurnId = params.turn?.id || null;
    actions.resolveSession(session.id);
    state.update(session.id, { status: "working", lastLine: "Codex is working", lastActivity: Date.now() });
  } else if (message.method === "turn/completed") {
    finishTurn(session, params.turn);
  } else if (message.method === "item/started" || message.method === "item/completed") {
    renderItem(session, params.item);
  } else if (message.method === "item/agentMessage/delta") {
    const id = params.itemId || `agent-${params.turnId || "active"}`;
    const event = session.events.find((item) => item.id === id);
    upsert(session, { id, type: "agent", title: "Codex", text: `${event?.text || ""}${params.delta || ""}`, status: "streaming" });
    state.update(session.id, { status: "working", lastLine: `${event?.text || ""}${params.delta || ""}`.slice(-200), lastActivity: Date.now() });
  } else if (message.method === "turn/diff/updated") {
    upsert(session, {
      id: `diff-${params.turnId}`, type: "diff", title: "Working diff",
      text: String(params.diff || "").slice(0, 30_000), status: "updated",
    });
  } else if (message.method === "error") {
    const text = params.error?.message || params.message || "Codex error";
    upsert(session, { id: `error-${Date.now()}`, type: "error", title: "Error", text, status: "failed" });
    state.update(session.id, { lastLine: text, lastActivity: Date.now() });
  } else if (message.method === "serverRequest/resolved") {
    actions.resolveRequest(session.id, params.requestId);
    session.requests.delete(String(params.requestId));
  }
}

function handleMessage(session, line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method && message.id !== undefined) return handleServerRequest(session, message);
  if (message.id !== undefined) {
    const pending = session.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(String(message.id));
    if (message.error) pending.reject(new Error(message.error.message || "Codex request failed"));
    else pending.resolve(message.result);
    return;
  }
  if (message.method) handleNotification(session, message);
}

function handleExit(session, error = null) {
  if (sessions.get(session.id) !== session) return;
  sessions.delete(session.id);
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error || new Error("Codex app-server exited"));
  }
  if (session.stopped) return;
  const detail = error?.message || session.stderr.trim().split("\n").pop() || "Codex app-server exited";
  state.update(session.id, { status: "dead", lastLine: detail, lastActivity: Date.now() });
  actions.resolveSession(session.id);
  actions.add({
    sessionId: session.id, agent: "codex", repo: session.repo, kind: "failed",
    title: session.purpose === "review" ? "Review failed" : "Codex driver stopped",
    detail, dedupeKey: `${session.id}:driver-exit`,
  });
}

export async function launch({ id, repo, prompt, extraArgs = [], sandbox = "workspace-write", purpose = "work" }) {
  const child = spawn(CONFIG.agentBins.codex, [...extraArgs, "app-server"], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
      ZUMO_SESSION: id,
      ZUMO_AGENT: "codex",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = {
    id, repo, child, events: [], pending: new Map(), requests: new Map(),
    nextId: 1, revision: 0, threadId: null, activeTurnId: null, stderr: "", stopped: false, purpose,
  };
  sessions.set(id, session);
  createInterface({ input: child.stdout }).on("line", (line) => handleMessage(session, line));
  child.stderr.on("data", (chunk) => { session.stderr = `${session.stderr}${chunk}`.slice(-8000); });
  child.on("error", (error) => handleExit(session, error));
  child.on("exit", () => handleExit(session));

  try {
    await request(session, "initialize", {
      clientInfo: { name: "zumo", title: "Zumo", version: "0.1.0" },
    });
    send(session, { method: "initialized", params: {} });
    const started = await request(session, "thread/start", {
      cwd: repo, approvalPolicy: "on-request", sandbox, serviceName: "zumo",
    });
    session.threadId = started?.thread?.id;
    if (!session.threadId) throw new Error("Codex did not return a thread id");
    state.update(id, { nativeSessionId: session.threadId });
    await sendMessage(id, prompt);
    return session.threadId;
  } catch (error) {
    stop(id);
    throw error;
  }
}

export async function sendMessage(id, text) {
  const session = sessions.get(id);
  if (!session) throw new Error("structured Codex session is offline");
  const message = String(text || "").trim();
  if (!message) throw new Error("message is required");
  const question = [...session.requests.values()].find((item) => item.method === "item/tool/requestUserInput");
  if (question) {
    const answers = Object.fromEntries((question.params.questions || []).map((item) => [item.id, { answers: [message] }]));
    send(session, { id: question.id, result: { answers } });
    session.requests.delete(String(question.id));
    actions.resolveRequest(id, question.id);
    state.update(id, { status: "working", lastLine: "Answer sent", lastActivity: Date.now() });
  } else {
    const params = { threadId: session.threadId, input: [{ type: "text", text: message }] };
    if (session.activeTurnId) {
      await request(session, "turn/steer", { ...params, expectedTurnId: session.activeTurnId });
    } else {
      const result = await request(session, "turn/start", params);
      session.activeTurnId = result?.turn?.id || session.activeTurnId;
    }
  }
  upsert(session, { id: `user-${Date.now()}`, type: "user", title: "You", text: message, status: "sent" });
}

export function events(id, since = 0) {
  const session = sessions.get(id);
  if (!session) return null;
  return {
    revision: session.revision,
    events: session.events
      .filter((event) => event.revision > since)
      .map(({ revision, ...event }) => ({ ...event })),
  };
}

export function respond(id, requestId, decision) {
  const session = sessions.get(id);
  const pending = session?.requests.get(String(requestId));
  if (!session || !pending) throw new Error("approval request is no longer pending");
  if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) throw new Error("invalid approval decision");
  send(session, { id: pending.id, result: { decision } });
  session.requests.delete(String(requestId));
  actions.resolveRequest(id, requestId);
  state.update(id, { status: "working", lastLine: `Approval ${decision}`, lastActivity: Date.now() });
}

export function stop(id) {
  const session = sessions.get(id);
  if (!session) return false;
  session.stopped = true;
  sessions.delete(id);
  try { session.child.kill("SIGTERM"); } catch {}
  return true;
}

export function stopAll() {
  for (const id of [...sessions.keys()]) stop(id);
}
