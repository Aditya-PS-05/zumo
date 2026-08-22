const connection = document.querySelector("#connection");
const pairView = document.querySelector("#pair-view");
const dashboard = document.querySelector("#dashboard");
const pairForm = document.querySelector("#pair-form");
const pairCode = document.querySelector("#pair-code");
const pairError = document.querySelector("#pair-error");
const actionsView = document.querySelector("#actions");
const sessionsView = document.querySelector("#sessions");
const actionCount = document.querySelector("#action-count");
const sessionCount = document.querySelector("#session-count");
const summary = document.querySelector("#summary");

const config = await fetch("/config.json", { cache: "no-store" }).then((response) => response.json());
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
let socket;
let heartbeat;
let reconnect;
let retry = 0;
let snapshot = { sessions: [], actions: [] };
let snapshotFingerprint = "";

function credentials() {
  try { return JSON.parse(localStorage.getItem("zumo-relay") || "null"); } catch { return null; }
}

function setConnection(text, live = false) {
  connection.textContent = text;
  connection.classList.toggle("live", live);
}

function relay(kind, payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ action: "relay", kind, payload }));
  return true;
}

function relativeTime(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(value || 0)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function button(label, action, primary = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (primary) node.className = "primary";
  node.addEventListener("click", action);
  return node;
}

function renderCard(item, type) {
  const card = document.createElement("article");
  card.className = `card ${item.kind || item.status || ""}`;
  const head = document.createElement("div");
  head.className = "card-head";
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = item.kind || item.status;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = relativeTime(item.createdAt || item.lastActivity);
  head.append(kind, time);
  const title = document.createElement("h2");
  title.textContent = type === "action" ? item.title : item.repo;
  const detail = document.createElement("p");
  detail.textContent = type === "action" ? item.detail : `${item.agent} · ${item.transport}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = type === "action" ? `${item.agent} · ${item.repo}` : item.purpose || "work";
  const buttons = document.createElement("div");
  buttons.className = "buttons";
  if (type === "action" && item.kind === "approval" && item.requestId != null) {
    buttons.append(
      button("Deny", () => relay("command", { action: "respond", actionId: item.id, decision: "decline" })),
      button("Allow once", () => relay("command", { action: "respond", actionId: item.id, decision: "accept" }), true),
    );
  } else if (type === "action" && item.kind === "question" && item.requestId != null) {
    const form = document.createElement("form");
    form.className = "question-form";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 5000;
    input.placeholder = "Answer Codex…";
    input.setAttribute("aria-label", "Answer Codex");
    const send = button("Send", () => {}, true);
    send.type = "submit";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const answer = input.value.trim();
      if (!answer) return;
      input.disabled = true;
      send.disabled = true;
      if (!relay("command", { action: "answer", actionId: item.id, answer })) {
        input.disabled = false;
        send.disabled = false;
      }
    });
    form.append(input, send);
    buttons.append(form);
  } else if (type === "action" && item.requestId == null) {
    buttons.append(button("Dismiss", () => relay("command", { action: "dismiss", actionId: item.id })));
  } else if (type === "session") {
    buttons.append(button("Stop", () => {
      if (confirm(`Stop ${item.repo}?`)) relay("command", { action: "kill", sessionId: item.id });
    }));
  }
  card.append(head, title, detail, meta, buttons);
  return card;
}

function render() {
  actionsView.replaceChildren();
  sessionsView.replaceChildren();
  for (const item of snapshot.actions || []) actionsView.append(renderCard(item, "action"));
  for (const item of (snapshot.sessions || []).filter((session) => session.status !== "dead")) sessionsView.append(renderCard(item, "session"));
  if (!actionsView.children.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "Inbox clear. Zumo will surface approvals, questions, failures, and completed work here."; actionsView.append(empty);
  }
  if (!sessionsView.children.length) {
    const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No live agent sessions on this machine."; sessionsView.append(empty);
  }
  const actionTotal = Number(snapshot.actionTotal ?? snapshot.actions?.length ?? 0);
  const sessionTotal = Number(snapshot.sessionTotal ?? snapshot.sessions?.length ?? 0);
  actionCount.textContent = String(actionTotal);
  sessionCount.textContent = String(sessionTotal);
  summary.textContent = actionTotal ? `${actionTotal} need attention` : `${sessionTotal} live · all clear`;
}

function showDashboard() {
  pairView.hidden = true;
  dashboard.hidden = false;
}

function connect(options = {}) {
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  const saved = credentials();
  const query = saved
    ? `role=client&device=${encodeURIComponent(saved.deviceId)}&token=${encodeURIComponent(saved.token)}`
    : `role=client&code=${encodeURIComponent(options.code || "")}`;
  setConnection("Connecting");
  socket = new WebSocket(`${config.webSocketUrl}?${query}`);
  socket.addEventListener("open", () => {
    retry = 0;
    setConnection("Live", true);
    socket.send(JSON.stringify({ action: "hello" }));
    heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ action: "heartbeat" })), 4 * 60_000);
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "paired") {
      localStorage.setItem("zumo-relay", JSON.stringify({ deviceId: message.deviceId, token: message.token }));
      pairError.hidden = true;
      showDashboard();
      relay("command", { action: "refresh" });
    } else if (message.type === "ready") {
      showDashboard();
      relay("command", { action: "refresh" });
    } else if (message.type === "relay" && message.kind === "snapshot") {
      const next = message.payload || snapshot;
      const fingerprint = JSON.stringify(next);
      if (fingerprint === snapshotFingerprint) return;
      snapshotFingerprint = fingerprint;
      snapshot = next;
      render();
    } else if (message.type === "error") {
      pairError.textContent = message.message;
      pairError.hidden = false;
    }
  });
  socket.addEventListener("close", () => {
    clearInterval(heartbeat);
    setConnection("Offline");
    if (credentials()) reconnect = setTimeout(() => connect(), Math.min(1000 * (2 ** retry++), 15_000));
    else if (options.code) {
      pairError.textContent = "Pairing failed or expired. Generate a new code on the workstation.";
      pairError.hidden = false;
    }
  });
}

pairForm.addEventListener("submit", (event) => {
  event.preventDefault();
  pairError.hidden = true;
  const code = pairCode.value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (code.length !== 16) {
    pairError.textContent = "Enter the full 16-character code.";
    pairError.hidden = false;
    return;
  }
  connect({ code });
});

for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => {
    document.querySelector("[data-tab].active")?.classList.remove("active");
    tab.classList.add("active");
    actionsView.hidden = tab.dataset.tab !== "actions";
    sessionsView.hidden = tab.dataset.tab !== "sessions";
  });
}

document.querySelector("#forget").addEventListener("click", () => {
  if (!confirm("Forget this paired machine on this browser?")) return;
  localStorage.removeItem("zumo-relay");
  socket?.close();
  location.reload();
});

if (credentials()) { showDashboard(); connect(); }
render();
