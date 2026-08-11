import { Terminal } from "/vendor/xterm.mjs";
import { FitAddon } from "/vendor/addon-fit.mjs";

const homeView = document.querySelector("#home-view");
const terminalView = document.querySelector("#terminal-view");
const sessionList = document.querySelector("#session-list");
const emptyState = document.querySelector("#empty-state");
const summary = document.querySelector("#session-summary");
const overviewTitle = document.querySelector("#overview-title");
const sessionsPanel = document.querySelector("#sessions-panel");
const historyPanel = document.querySelector("#history-panel");
const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");
const historySummary = document.querySelector("#history-summary");
const historySearch = document.querySelector("#history-search");
const liveCount = document.querySelector("#live-count");
const launchDialog = document.querySelector("#launch-dialog");
const launchForm = document.querySelector("#launch-form");
const launchError = document.querySelector("#launch-error");
const submitLaunch = document.querySelector("#submit-launch");
const repoInput = document.querySelector("#repo-input");
const pushButton = document.querySelector("#push-button");
const toast = document.querySelector("#toast");
const connectionState = document.querySelector("#connection-state");
const ctrlKey = document.querySelector("#ctrl-key");
const imageInput = document.querySelector("#image-input");

const STATUS_LABELS = {
  "needs-approval": "Needs approval",
  working: "Working",
  idle: "Idle",
  dead: "Ended",
};
const KEY_SEQUENCES = {
  escape: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
  enter: "\r",
};

// SGR mouse-wheel events (mode 1006). Full-screen TUIs like Claude Code run in the
// alternate screen (no terminal scrollback) but enable mouse tracking, so forwarding
// these scrolls the app's own transcript — the only way to read back the conversation.
const WHEEL_UP = "\x1b[<64;1;1M"; // toward older output
const WHEEL_DOWN = "\x1b[<65;1;1M"; // toward newer output

let sessions = [];
let historySessions = [];
let homeMode = "sessions";
let pollTimer;
let historySearchTimer;
let currentSessionId = null;
let terminal = null;
let fitAddon = null;
let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let resizeObserver = null;
let controlArmed = false;
let toastTimer;
let lastSentCols = 0;
let lastSentRows = 0;
let resizeTimer = null;
let sessionWaitDeadline = 0;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json", ...options.headers } : options.headers,
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty response */ }
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}

function sessionLabel(session) {
  if (!session) return "";
  if (session?.repo && session.repo !== "(unknown)") {
    return session.repo.split(/[\\/]/).filter(Boolean).pop();
  }
  return session.id?.replace(/^p23-/, "") || "session";
}

function relativeTime(timestamp) {
  if (!timestamp) return "no activity yet";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function durationSince(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function renderSessions() {
  sessionList.replaceChildren();
  const live = sessions.filter((session) => session.status !== "dead").length;
  const approvals = sessions.filter((session) => session.status === "needs-approval").length;
  liveCount.textContent = String(live);
  if (homeMode === "sessions") {
    summary.textContent = approvals
      ? `${approvals} waiting · ${live} live`
      : `${live} live · ${sessions.length} total`;
  }

  for (const session of sessions) {
    const card = document.createElement("article");
    card.className = `session-card status-${session.status}`;

    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");

    const main = document.createElement("div");
    main.className = "session-main";
    main.tabIndex = 0;
    main.setAttribute("role", "link");
    main.setAttribute("aria-label", `Open ${sessionLabel(session)} terminal`);

    const heading = document.createElement("div");
    heading.className = "session-heading";
    const name = document.createElement("strong");
    name.textContent = sessionLabel(session);
    const status = document.createElement("span");
    status.className = "status-pill";
    status.textContent = STATUS_LABELS[session.status] || session.status;
    heading.append(name, status);

    const lastLine = document.createElement("p");
    lastLine.className = "last-line";
    lastLine.textContent = session.lastLine || (session.status === "dead" ? "No recorded output" : "Waiting for terminal output…");

    const meta = document.createElement("p");
    meta.className = "session-meta";
    meta.textContent = `${durationSince(session.createdAt)} elapsed · ${relativeTime(session.lastActivity || session.lastEventAt)}`;
    main.append(heading, lastLine, meta);

    const kill = document.createElement("button");
    kill.className = "card-kill";
    kill.type = "button";
    kill.textContent = session.status === "dead" ? "×" : "■";
    kill.setAttribute("aria-label", session.status === "dead" ? `Remove ${sessionLabel(session)}` : `Kill ${sessionLabel(session)}`);
    kill.addEventListener("click", () => removeSession(session));

    const open = () => session.status === "dead" ? showToast("That terminal has ended") : showTerminal(session.id);
    main.addEventListener("click", open);
    main.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });
    card.append(dot, main, kill);
    sessionList.append(card);
  }

  emptyState.hidden = sessions.length > 0;
  document.querySelector("#launch-fab").hidden = homeMode !== "sessions" || sessions.length === 0;
  if (homeMode === "history" && historySessions.length) renderHistory();
}

function renderHistory() {
  historyList.replaceChildren();
  const activeIds = new Set(
    sessions.filter((session) => session.status !== "dead").map((session) => session.claudeSessionId).filter(Boolean),
  );
  for (const item of historySessions) {
    const card = document.createElement("article");
    card.className = "history-card";

    const head = document.createElement("div");
    head.className = "history-card-head";
    const repo = document.createElement("span");
    repo.className = "history-repo";
    repo.textContent = item.repoLabel;
    repo.title = item.project;
    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = relativeTime(item.updatedAt);
    head.append(repo, time);

    const title = document.createElement("h2");
    title.className = "history-title";
    title.textContent = item.title;

    const last = document.createElement("p");
    last.className = "history-last";
    last.textContent = item.lastPrompt && item.lastPrompt !== item.title
      ? `Latest: ${item.lastPrompt}`
      : `${item.promptCount} prompt${item.promptCount === 1 ? "" : "s"}`;

    const footer = document.createElement("div");
    footer.className = "history-footer";
    const id = document.createElement("span");
    id.className = "history-id";
    id.textContent = item.sessionId;
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "resume-button";
    const active = activeIds.has(item.sessionId);
    resume.disabled = active || !item.available;
    resume.textContent = active ? "Running" : item.available ? "Resume" : "Repo missing";
    resume.addEventListener("click", () => resumeHistorySession(item, resume));
    footer.append(id, resume);
    card.append(head, title, last, footer);
    historyList.append(card);
  }
  historyEmpty.hidden = historySessions.length > 0;
  historySummary.textContent = historySessions.length
    ? `${historySessions.length} resumable laptop session${historySessions.length === 1 ? "" : "s"}`
    : "No matching Claude sessions";
  if (homeMode === "history") summary.textContent = `${historySessions.length} saved`;
}

async function loadHistory(query = "") {
  historySummary.textContent = "Loading Claude history…";
  try {
    const payload = await api(`/api/history?limit=100&q=${encodeURIComponent(query)}`);
    historySessions = payload.sessions || [];
    renderHistory();
  } catch (error) {
    historySessions = [];
    renderHistory();
    historySummary.textContent = error.message;
  }
}

async function resumeHistorySession(item, button) {
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    const { id } = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ resumeSessionId: item.sessionId }),
    });
    await refreshSessions({ quiet: true });
    showTerminal(id);
  } catch (error) {
    showToast(error.message);
    renderHistory();
  }
}

function setHomeMode(mode) {
  homeMode = mode === "history" ? "history" : "sessions";
  sessionsPanel.hidden = homeMode !== "sessions";
  historyPanel.hidden = homeMode !== "history";
  overviewTitle.textContent = homeMode === "history" ? "Claude history" : "Agent sessions";
  for (const tab of document.querySelectorAll("[data-home-tab]")) {
    tab.classList.toggle("active", tab.dataset.homeTab === homeMode);
  }
  document.querySelector("#launch-fab").hidden = homeMode !== "sessions" || sessions.length === 0;
  if (homeMode === "history") loadHistory(historySearch.value);
  else renderSessions();
}

async function refreshSessions({ quiet = false } = {}) {
  try {
    const payload = await api("/api/sessions");
    sessions = payload.sessions || [];
    renderSessions();
  } catch (error) {
    summary.textContent = "Daemon unavailable";
    if (!quiet) showToast(error.message);
  }
}

function schedulePolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden && !currentSessionId) refreshSessions({ quiet: true });
  }, 2000);
}

async function removeSession(session) {
  const verb = session.status === "dead" ? "Remove" : "Kill";
  if (!window.confirm(`${verb} ${sessionLabel(session)}?`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    await refreshSessions();
  } catch (error) {
    showToast(error.message);
  }
}

async function loadRepos() {
  repoInput.replaceChildren(new Option("Scanning repositories…", ""));
  repoInput.disabled = true;
  try {
    const { repos = [] } = await api("/api/repos");
    repoInput.replaceChildren();
    if (!repos.length) {
      repoInput.append(new Option("No git repositories found", ""));
    } else {
      for (const repo of repos) repoInput.append(new Option(repo, repo));
    }
  } catch (error) {
    repoInput.replaceChildren(new Option(error.message, ""));
  } finally {
    repoInput.disabled = false;
  }
}

function openLaunchDialog() {
  launchError.hidden = true;
  if (!launchDialog.open) launchDialog.showModal();
  loadRepos();
  setTimeout(() => repoInput.focus(), 50);
}

launchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  launchError.hidden = true;
  submitLaunch.disabled = true;
  submitLaunch.firstChild.textContent = "Launching… ";
  try {
    const body = {
      repo: repoInput.value,
      prompt: document.querySelector("#prompt-input").value,
      extraArgs: document.querySelector("#args-input").value,
    };
    const { id } = await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
    launchDialog.close();
    launchForm.reset();
    await refreshSessions({ quiet: true });
    showTerminal(id);
  } catch (error) {
    launchError.textContent = error.message;
    launchError.hidden = false;
  } finally {
    submitLaunch.disabled = false;
    submitLaunch.firstChild.textContent = "Launch session ";
  }
});

function sendTerminal(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "input", data }));
  }
}

// Copy the current selection if there is one, otherwise the visible screen text.
// Full-screen TUIs capture touch for their own scrolling, so on-screen selection is
// hard — copying the visible screen is the reliable path to grabbing a Claude reply.
async function copyTerminal() {
  if (!terminal) return;
  let text = terminal.hasSelection() ? terminal.getSelection() : "";
  if (!text) {
    const buf = terminal.buffer.active;
    const rows = [];
    for (let i = 0; i < terminal.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) rows.push(line.translateToString(true));
    }
    text = rows.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (!text) { showToast("Nothing to copy"); return; }
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${text.length} chars`);
  } catch {
    showToast("Copy blocked by browser");
  }
}

// Downscale on-device to Claude's ideal max dimension so uploads stay small and fast.
async function scaledImageBase64(file, max = 1568) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}

// Upload an image to the daemon, then drop its saved path into Claude's prompt. Claude
// reads image files by path, so you then type your question and hit Enter.
async function uploadImage(file) {
  if (!file || !currentSessionId) return;
  if (!file.type.startsWith("image/")) { showToast("Not an image"); return; }
  showToast("Uploading image…");
  try {
    const data = await scaledImageBase64(file);
    const { path } = await api(`/api/sessions/${encodeURIComponent(currentSessionId)}/image`, {
      method: "POST",
      body: JSON.stringify({ data, ext: "jpg" }),
    });
    sendTerminal(`${path} `);
    showToast("Image added — type your question, then ↵");
  } catch (error) {
    showToast(error.message || "Image upload failed");
  }
}

// Scroll the running session, not xterm's local buffer. A mouse-tracking app (Claude
// Code and other full-screen TUIs) gets wheel events so it scrolls its own transcript;
// a plain shell has no mouse tracking, so we scroll xterm's local scrollback instead.
function appUsesMouse() {
  const mode = terminal?.modes?.mouseTrackingMode;
  return Boolean(mode) && mode !== "none";
}

function scrollApp(direction, steps = 3) {
  if (!terminal) return;
  if (appUsesMouse()) sendTerminal((direction < 0 ? WHEEL_UP : WHEEL_DOWN).repeat(steps));
  else terminal.scrollLines(direction * steps);
}

// Fit the terminal and push the size — but ONLY when it actually changed. The mobile
// keyboard sliding in/out fires the resize observer many times per animation; every
// resize makes Claude's full-screen TUI redraw, which is the flicker / duplicated text /
// vanishing-output the phone sees. Deduping (skip no-op resizes) plus debouncing collapses
// each keyboard toggle into one stable resize.
function sendResize() {
  if (!fitAddon || !terminal) return;
  try { fitAddon.fit(); } catch { return; }
  const { cols, rows } = terminal;
  if (!cols || !rows) return; // transient zero size mid-layout — ignore
  if (cols === lastSentCols && rows === lastSentRows) return;
  lastSentCols = cols;
  lastSentRows = rows;
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

function scheduleResize(delay = 180) {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, delay);
}

// Pin the terminal view to the area ABOVE the mobile keyboard. By default the soft
// keyboard overlays the page, hiding Claude's input line at the bottom — so you edit
// blind and erasing looks like it "appends". visualViewport reports the actually-visible
// height (iOS + Android); we size the view to it so the input stays on screen and the
// PTY geometry matches what's rendered.
function syncViewportHeight() {
  if (!window.visualViewport) return;
  if (terminalView.hidden) { terminalView.style.height = ""; return; }
  terminalView.style.height = `${Math.round(window.visualViewport.height)}px`;
  scheduleResize(60);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncViewportHeight);
  window.visualViewport.addEventListener("scroll", syncViewportHeight);
}

function setConnection(label, connected = false) {
  connectionState.textContent = label;
  connectionState.classList.toggle("connected", connected);
}

function connectTerminal() {
  if (!currentSessionId || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(reconnectTimer);
  setConnection(reconnectAttempt ? "Reconnecting" : "Connecting");
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const id = currentSessionId;
  socket = new WebSocket(`${scheme}://${location.host}/api/sessions/${encodeURIComponent(id)}/pty`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    if (currentSessionId !== id) return socket.close();
    reconnectAttempt = 0;
    setConnection("Live", true);
    lastSentCols = 0; lastSentRows = 0; // force one size sync to the fresh server-side view
    sendResize();
    terminal?.focus();
  });
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) terminal?.write(new Uint8Array(event.data));
    else terminal?.write(event.data);
  });
  socket.addEventListener("close", (event) => {
    if (currentSessionId !== id) return; // navigated away — do nothing
    if (event.code === 4404 || event.code === 1000) {
      // The session ended server-side while we're still watching it. It may just be
      // churning/resuming under the same id, so poll for it and re-attach if it comes
      // back — only declaring "Ended" if it stays gone past the grace window.
      setConnection("Reconnecting");
      waitForSession(id);
      return;
    }
    setConnection("Offline");
    const delay = Math.min(500 * (2 ** reconnectAttempt++), 5_000);
    reconnectTimer = setTimeout(connectTerminal, delay);
  });
}

// Poll the session list after a server-side close; reconnect the moment the id is alive
// again, or give up after a grace window. Makes brief session churn invisible on the phone.
async function waitForSession(id) {
  if (currentSessionId !== id) return;
  if (!sessionWaitDeadline) sessionWaitDeadline = Date.now() + 30_000;
  try {
    const { sessions = [] } = await api("/api/sessions");
    if (currentSessionId !== id) return;
    if (sessions.some((s) => s.id === id && s.status !== "dead")) {
      sessionWaitDeadline = 0;
      reconnectAttempt = 0;
      connectTerminal();
      return;
    }
  } catch { /* daemon momentarily unreachable — keep waiting */ }
  if (Date.now() >= sessionWaitDeadline) {
    sessionWaitDeadline = 0;
    setConnection("Ended");
    terminal?.writeln("\r\n\x1b[90m[zumo: session ended]\x1b[0m");
    return;
  }
  reconnectTimer = setTimeout(() => waitForSession(id), 1500);
}

function setupPinchZoom(element) {
  let startDistance = 0;
  let startSize = 13;
  const distance = (touches) => Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
  element.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 2 || !terminal) return;
    startDistance = distance(event.touches);
    startSize = terminal.options.fontSize;
  }, { passive: true });
  element.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 2 || !startDistance || !terminal) return;
    event.preventDefault();
    terminal.options.fontSize = Math.max(9, Math.min(24, startSize * distance(event.touches) / startDistance));
    scheduleResize(60);
  }, { passive: false });
}

// One-finger vertical drag scrolls the session. Only hijacked for mouse-tracking apps
// (Claude Code) where xterm's own touch-scroll hits empty local scrollback; a plain
// shell keeps xterm's native touch behaviour.
function setupSwipeScroll(element) {
  const STEP = 22; // px of drag per scroll notch
  let active = false;
  let lastY = 0;
  let accum = 0;
  element.addEventListener("touchstart", (event) => {
    active = event.touches.length === 1 && appUsesMouse();
    if (active) { lastY = event.touches[0].clientY; accum = 0; }
  }, { passive: true, capture: true });
  element.addEventListener("touchmove", (event) => {
    if (!active || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    accum += y - lastY;
    lastY = y;
    // Finger down (accum > 0) reveals older output → scroll up; finger up → scroll down.
    while (Math.abs(accum) >= STEP) {
      if (accum > 0) { scrollApp(-1, 1); accum -= STEP; }
      else { scrollApp(1, 1); accum += STEP; }
    }
    event.preventDefault();
  }, { passive: false, capture: true });
  const end = () => { active = false; };
  element.addEventListener("touchend", end, { capture: true });
  element.addEventListener("touchcancel", end, { capture: true });
}

function createTerminal() {
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 4000,
    allowProposedApi: false,
    theme: {
      background: "#0a0c09",
      foreground: "#e7eadf",
      cursor: "#c8f759",
      selectionBackground: "#455426",
      black: "#11130f",
      brightBlack: "#6c7362",
      red: "#ff655d",
      green: "#8fd65a",
      yellow: "#f3c969",
      blue: "#77a9ff",
      magenta: "#c59cff",
      cyan: "#65d5ca",
      white: "#e7eadf",
    },
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.querySelector("#terminal"));
  if (terminal.textarea) {
    terminal.textarea.id = "terminal-input";
    terminal.textarea.name = "terminal-input";
    terminal.textarea.autocomplete = "off";
    // Mobile keyboards mangle terminal input: predictive text, auto-capitalise and
    // autocorrect reinsert/duplicate characters when you edit a word. Turn them all off.
    terminal.textarea.spellcheck = false;
    terminal.textarea.setAttribute("autocorrect", "off");
    terminal.textarea.setAttribute("autocapitalize", "off");
    terminal.textarea.setAttribute("autocomplete", "off");
  }
  terminal.onData((data) => {
    if (controlArmed && data.length === 1) {
      controlArmed = false;
      ctrlKey.classList.remove("active");
      const code = data.toUpperCase().charCodeAt(0);
      sendTerminal(String.fromCharCode(code & 31));
    } else {
      sendTerminal(data);
    }
  });
  resizeObserver = new ResizeObserver(() => scheduleResize());
  resizeObserver.observe(document.querySelector("#terminal"));
  setupPinchZoom(document.querySelector("#terminal"));
  setupSwipeScroll(document.querySelector("#terminal"));
  requestAnimationFrame(sendResize);
}

function teardownTerminal() {
  currentSessionId = null;
  clearTimeout(reconnectTimer);
  reconnectAttempt = 0;
  sessionWaitDeadline = 0;
  if (socket) {
    const old = socket;
    socket = null;
    old.close(1000, "left terminal");
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
  clearTimeout(resizeTimer);
  resizeTimer = null;
  lastSentCols = 0;
  lastSentRows = 0;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
  controlArmed = false;
  ctrlKey.classList.remove("active");
  document.querySelector("#terminal").replaceChildren();
}

function showTerminal(id, updateHistory = true) {
  teardownTerminal();
  currentSessionId = id;
  homeView.hidden = true;
  terminalView.hidden = false;
  syncViewportHeight();
  document.querySelector("#terminal-name").textContent = sessionLabel(sessions.find((item) => item.id === id)) || id.replace(/^p23-/, "");
  if (updateHistory && location.pathname !== `/sessions/${id}`) history.pushState({ id }, "", `/sessions/${id}`);
  createTerminal();
  connectTerminal();
}

function showHome(updateHistory = true) {
  teardownTerminal();
  terminalView.hidden = true;
  terminalView.style.height = "";
  homeView.hidden = false;
  if (updateHistory && location.pathname !== "/") history.pushState({}, "", "/");
  refreshSessions({ quiet: true });
}

async function killCurrentSession() {
  const session = sessions.find((item) => item.id === currentSessionId);
  if (!currentSessionId || !window.confirm(`Kill ${sessionLabel(session) || currentSessionId}?`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(currentSessionId)}`, { method: "DELETE" });
    showHome();
  } catch (error) { showToast(error.message); }
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function initializePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js");
    const subscription = await registration.pushManager.getSubscription();
    pushButton.hidden = Boolean(subscription) || Notification.permission === "denied";
  } catch {
    pushButton.hidden = true;
  }
}

pushButton.addEventListener("click", async () => {
  pushButton.disabled = true;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted");
    const [{ publicKey }, registration] = await Promise.all([
      api("/api/push/vapid"),
      navigator.serviceWorker.ready,
    ]);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription) });
    pushButton.hidden = true;
    showToast("Alerts enabled on this device");
  } catch (error) {
    showToast(error.message);
    pushButton.disabled = false;
  }
});

for (const trigger of document.querySelectorAll(".launch-trigger")) trigger.addEventListener("click", openLaunchDialog);
for (const tab of document.querySelectorAll("[data-home-tab]")) {
  tab.addEventListener("click", () => setHomeMode(tab.dataset.homeTab));
}
historySearch.addEventListener("input", () => {
  clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(() => loadHistory(historySearch.value), 250);
});
document.querySelector("#close-dialog").addEventListener("click", () => launchDialog.close());
document.querySelector("#back-button").addEventListener("click", () => history.back());
document.querySelector("#kill-button").addEventListener("click", killCurrentSession);
document.querySelector("#keybar").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "copy") { copyTerminal(); return; } // no focus: don't pop the keyboard
  if (button.dataset.action === "image") { imageInput.click(); return; }
  if (button.dataset.control) {
    controlArmed = !controlArmed;
    button.classList.toggle("active", controlArmed);
  } else if (button.dataset.scroll) {
    scrollApp(button.dataset.scroll === "up" ? -1 : 1);
  } else if (button.dataset.key) {
    sendTerminal(KEY_SEQUENCES[button.dataset.key]);
  }
  terminal?.focus();
});

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  imageInput.value = ""; // allow re-picking the same file
  if (file) uploadImage(file);
});

// Pasting an image (long-press → Paste) uploads it; text paste falls through to the terminal.
window.addEventListener("paste", (event) => {
  if (!currentSessionId || terminalView.hidden) return;
  const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith("image/"));
  if (!item) return;
  const file = item.getAsFile();
  if (file) { event.preventDefault(); uploadImage(file); }
});

window.addEventListener("popstate", () => {
  const match = location.pathname.match(/^\/sessions\/([^/]+)$/);
  if (match) showTerminal(decodeURIComponent(match[1]), false);
  else showHome(false);
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (currentSessionId) connectTerminal();
  else refreshSessions({ quiet: true });
});

await refreshSessions({ quiet: true });
schedulePolling();
initializePush();
const initialSession = location.pathname.match(/^\/sessions\/([^/]+)$/)?.[1];
if (initialSession) showTerminal(decodeURIComponent(initialSession), false);
