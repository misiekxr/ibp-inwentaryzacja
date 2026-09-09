const CACHE_VERSION = "ibp-v31";

const CORE_FILES = [
  "./",
  "index.html",
  "style.css",
  "sync.js",
  "app.js",
  "building-locations.json",
  "manifest.json",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
  "vendor/idb.js",
  "vendor/jspdf.umd.min.js",
  "vendor/ptserif-font.js",
  "vendor/pdf.min.mjs",
  "vendor/pdf.worker.min.mjs",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(CORE_FILES);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Cache-owanie tylko wlasnych, statycznych plikow appki (ten sam origin).
  // Zewnetrzne zadania (serwer synchronizacji ppoz.gteam.pl - obrazy planow,
  // zdjecia, wywolania API z URL-em zmieniajacym sie co kazde zapytanie np.
  // ?since=...) NIGDY nie trafiaja do Cache Storage - inaczej rosloby to bez
  // ograniczen i zapychalo limit miejsca strony (dokladnie to sie stalo:
  // QuotaExceededError mimo malej faktycznej ilosci danych w IndexedDB).
  // Te dane i tak trafiaja gdzie trzeba - do IndexedDB przez sync.js.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        const fresh = await fetch(event.request);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(event.request, fresh.clone());
        return fresh;
      } catch (err) {
        return cached || Response.error();
      }
    })()
  );
});
