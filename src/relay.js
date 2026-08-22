import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { CONFIG } from "./config.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let publishTimer = null;
let rotateTimer = null;
let retry = 0;
let code = generatePairingCode();
let expiresAt = null;
let lastError = "";
let lastSnapshot = "";
let snapshotProvider = () => ({ sessions: [], actions: [] });
let commandHandler = async () => ({ ok: false, error: "relay command handler unavailable" });

export function generatePairingCode() {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return output.slice(0, 16);
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function registerPairing() {
  expiresAt = Date.now() + 5 * 60_000;
  send({ action: "register", code });
}

export function publishSnapshot(force = false) {
  const payload = snapshotProvider();
  const fingerprint = JSON.stringify(payload);
  if (!force && fingerprint === lastSnapshot) return false;
  if (!send({ action: "relay", kind: "snapshot", payload })) return false;
  lastSnapshot = fingerprint;
  return true;
}

async function onMessage(raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return; }
  if (message.type === "pairingReady") {
    expiresAt = Date.now() + Number(message.expiresIn || 300) * 1000;
  } else if (message.type === "error") {
    lastError = String(message.message || "relay error");
  } else if (message.type === "relay" && message.from === "client" && message.kind === "command") {
    const result = await commandHandler(message.payload || {}).catch((error) => ({ ok: false, error: error.message }));
    send({ action: "relay", kind: "ack", payload: result });
    publishSnapshot(message.payload?.action === "refresh");
  }
}

function connect() {
  if (!CONFIG.relay?.url || !CONFIG.relay?.deviceId || !CONFIG.relay?.token) return;
  clearTimeout(reconnectTimer);
  const query = new URLSearchParams({
    role: "device", device: CONFIG.relay.deviceId, token: CONFIG.relay.token,
  });
  socket = new WebSocket(`${CONFIG.relay.url}?${query}`);
  socket.on("open", () => {
    retry = 0;
    lastError = "";
    send({ action: "hello" });
    registerPairing();
    publishSnapshot(true);
    clearInterval(heartbeatTimer);
    clearInterval(publishTimer);
    clearInterval(rotateTimer);
    heartbeatTimer = setInterval(() => send({ action: "heartbeat" }), 4 * 60_000);
    publishTimer = setInterval(publishSnapshot, 3_000);
    rotateTimer = setInterval(() => {
      code = generatePairingCode();
      registerPairing();
    }, 4 * 60_000);
  });
  socket.on("message", onMessage);
  socket.on("error", (error) => { lastError = error.message; });
  socket.on("close", () => {
    clearInterval(heartbeatTimer);
    clearInterval(publishTimer);
    clearInterval(rotateTimer);
    socket = null;
    reconnectTimer = setTimeout(connect, Math.min(1000 * (2 ** retry++), 30_000));
  });
}

export function rotatePairing() {
  if (!CONFIG.relay?.url) return false;
  code = generatePairingCode();
  registerPairing();
  return true;
}

export function status() {
  return {
    configured: Boolean(CONFIG.relay?.url), connected: socket?.readyState === WebSocket.OPEN,
    pairingCode: code.match(/.{1,4}/g)?.join("-") || code,
    expiresAt, clientUrl: CONFIG.relay?.clientUrl || null, lastError,
  };
}

export function start({ snapshot, onCommand }) {
  snapshotProvider = snapshot;
  commandHandler = onCommand;
  connect();
}

export function stop() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearInterval(publishTimer);
  clearInterval(rotateTimer);
  try { socket?.close(); } catch {}
  socket = null;
}
