#!/usr/bin/env node
import WebSocket from "ws";

const baseUrl = process.env.ZUMO_URL || "http://127.0.0.1:7323";
const timeoutMs = 15_000;

const relay = await fetch(`${baseUrl}/api/relay`).then((response) => {
  if (!response.ok) throw new Error(`local relay returned ${response.status}`);
  return response.json();
});
const cloudConfig = await fetch(`${relay.clientUrl}/config.json`, { cache: "no-store" }).then((response) => {
  if (!response.ok) throw new Error(`cloud client config returned ${response.status}`);
  return response.json();
});
const code = String(relay.pairingCode || "").replace(/[^A-Z2-7]/gi, "");
if (!relay.connected || code.length !== 16) throw new Error("local relay is not ready to pair");

await new Promise((resolve, reject) => {
  const socket = new WebSocket(`${cloudConfig.webSocketUrl}?role=client&code=${code}`);
  const timeout = setTimeout(() => {
    socket.terminate();
    reject(new Error("relay smoke test timed out"));
  }, timeoutMs);
  socket.on("open", () => socket.send(JSON.stringify({ action: "hello" })));
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "paired") {
      socket.send(JSON.stringify({ action: "relay", kind: "command", payload: { action: "refresh" } }));
    } else if (message.type === "relay" && message.kind === "snapshot") {
      if (!Array.isArray(message.payload?.sessions) || !Array.isArray(message.payload?.actions)) {
        reject(new Error("relay snapshot has an invalid shape"));
        socket.close();
        return;
      }
      clearTimeout(timeout);
      socket.close();
      resolve();
    } else if (message.type === "error") {
      reject(new Error(message.message || "relay rejected the smoke test"));
      socket.close();
    }
  });
  socket.on("error", reject);
});

await fetch(`${baseUrl}/api/relay/pair`, { method: "POST" });
console.log("AWS relay pairing and sanitized snapshot: ok");
