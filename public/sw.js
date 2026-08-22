const CACHE = "zumo-shell-v2";
const SHELL = ["/", "/styles.css", "/app.js", "/composer.js", "/manifest.webmanifest", "/icon.svg", "/vendor/xterm.css", "/vendor/xterm.mjs", "/vendor/addon-fit.mjs"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = { body: event.data?.text() || "" }; }
  event.waitUntil(self.registration.showNotification(payload.title || "zumo", {
    body: payload.body || "",
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: { url: payload.url || "/" },
    tag: payload.url || "zumo",
    renotify: true,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const client = clients[0];
    if (client) {
      await client.navigate(target);
      return client.focus();
    }
    return self.clients.openWindow(target);
  }));
});
