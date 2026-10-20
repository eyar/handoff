// Handoff Service Worker — PWA & Web Share Target
const CACHE_NAME = "handoff-cache-v3";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/favicon.svg",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

const DB_NAME = "handoff_share_db";
const DB_VERSION = 1;
const STORE_NAME = "shares";

function openShareDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSharePayload(payload) {
  const db = await openShareDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(payload);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 1. Install Event — Pre-cache static shell & activate immediately
self.addEventListener("install", (event) => {
  // Uploads never need this worker. Without a route, Chrome passes every PUT body through it and keeps
  // the bodies alive in this worker's process for the whole transfer (measured: +300 MB on a 300 MB
  // encrypted upload). Static routing sends them straight to the network. Browsers without the API skip it.
  if (typeof event.addRoutes === "function") {
    event.waitUntil(
      event
        .addRoutes([{ condition: { requestMethod: "PUT" }, source: "network" }])
        .catch((err) => console.warn("[SW] Static routes not registered:", err))
    );
  }
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch((err) => console.warn("[SW] Cache preload error:", err))
  );
  self.skipWaiting();
});

// 2. Activate Event — Clean up stale caches & claim clients
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              return caches.delete(key);
            }
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

// 3. Fetch Event — Intercept Web Share Target & handle network requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Web Share Target: POST handler (Multipart form-data with files, text, title, url)
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const title = formData.get("title") || "";
          const text = formData.get("text") || "";
          const sharedUrl = formData.get("url") || "";
          const fileEntries = formData.getAll("files") || [];

          const files = [];
          for (const entry of fileEntries) {
            if (entry && typeof entry === "object" && "size" in entry && entry.size > 0) {
              files.push(entry);
            }
          }

          const shareItem = {
            title: String(title),
            text: String(text),
            url: String(sharedUrl),
            files,
            createdAt: Date.now()
          };

          await saveSharePayload(shareItem);

          // Notify any open window clients immediately
          const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
          for (const client of clients) {
            client.postMessage({ type: "SHARE_TARGET_RECEIVED" });
          }
        } catch (err) {
          console.error("[SW] Error parsing share target POST:", err);
        }

        // Redirect to main page with query flag (303 See Other is standard for POST-redirect-GET)
        return Response.redirect("/?shared=1", 303);
      })()
    );
    return;
  }

  // Web Share Target: GET handler (Fallback for text/link shares)
  if (event.request.method === "GET" && url.pathname === "/share-target") {
    event.respondWith(
      (async () => {
        const title = url.searchParams.get("title") || "";
        const text = url.searchParams.get("text") || "";
        const sharedUrl = url.searchParams.get("url") || "";

        if (title || text || sharedUrl) {
          try {
            await saveSharePayload({
              title,
              text,
              url: sharedUrl,
              files: [],
              createdAt: Date.now()
            });

            const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const client of clients) {
              client.postMessage({ type: "SHARE_TARGET_RECEIVED" });
            }
          } catch (err) {
            console.error("[SW] Error parsing share target GET:", err);
          }
        }
        return Response.redirect("/?shared=1", 303);
      })()
    );
    return;
  }

  // For external requests (Supabase, Paddle, Cloudflare tunnels), let network handle directly
  if (url.origin !== self.location.origin || event.request.method !== "GET") {
    return;
  }

  // For same-origin static assets: Network-first, fallback to cache (offline support)
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
