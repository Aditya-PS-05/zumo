import webpush from "web-push";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CONFIG, SUBSCRIPTIONS } from "./config.js";

let ready = false;
if (CONFIG.vapid?.publicKey && CONFIG.vapid?.privateKey) {
  webpush.setVapidDetails(CONFIG.vapid.subject || "mailto:zumo@localhost", CONFIG.vapid.publicKey, CONFIG.vapid.privateKey);
  ready = true;
} else {
  console.warn("[push] no VAPID keys in config — push disabled (run: bun run setup)");
}

function loadSubs() {
  if (!existsSync(SUBSCRIPTIONS)) return [];
  try { return JSON.parse(readFileSync(SUBSCRIPTIONS, "utf8")); } catch { return []; }
}
function saveSubs(subs) {
  writeFileSync(SUBSCRIPTIONS, JSON.stringify(subs, null, 2));
}

export function vapidPublicKey() {
  return CONFIG.vapid?.publicKey || null;
}

export function addSubscription(sub) {
  if (!sub?.endpoint) throw new Error("invalid subscription");
  const subs = loadSubs().filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  saveSubs(subs);
  return subs.length;
}

// payload: {title, body, url}
export async function sendToAll(payload) {
  if (!ready) return 0;
  const subs = loadSubs();
  if (!subs.length) return 0;
  const data = JSON.stringify(payload);
  const dead = new Set();
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, data, { TTL: 3600 });
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.add(sub.endpoint);
      else console.error("[push] send failed:", e.statusCode || e.message);
    }
  }));
  if (dead.size) saveSubs(subs.filter((s) => !dead.has(s.endpoint)));
  return subs.length - dead.size;
}
