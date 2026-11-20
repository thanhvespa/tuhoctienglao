/* Service Worker for Offline-First Language Study PWA */
const SHELL_CACHE = "course-shell-v4";
const MEDIA_CACHE = "course-media-v2";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./curriculum_data.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      await Promise.allSettled(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => null)
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== MEDIA_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

async function handleRangeResponse(cachedResponse, rangeHeader) {
  const buf = await cachedResponse.arrayBuffer();
  const total = buf.byteLength;
  const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!match) return cachedResponse;

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
  if (Number.isNaN(start) || start >= total || end < start) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }
  const slice = buf.slice(start, end + 1);
  const headers = new Headers(cachedResponse.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
  headers.set("Content-Length", String(slice.byteLength));
  headers.set("Accept-Ranges", "bytes");
  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  const isMedia =
    url.pathname.includes("/Media-Audio/") ||
    url.pathname.endsWith(".mp3") ||
    url.pathname.endsWith(".m4a");

  if (isMedia) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(MEDIA_CACHE);
        const cleanReq = new Request(url.href, { credentials: "same-origin" });
        const cached = await cache.match(cleanReq);
        const rangeHeader = req.headers.get("range");

        if (cached) {
          return rangeHeader ? handleRangeResponse(cached, rangeHeader) : cached;
        }

        try {
          const networkResp = await fetch(cleanReq);
          if (networkResp && networkResp.ok && networkResp.status === 200) {
            cache.put(cleanReq, networkResp.clone()).catch(() => {});
            return rangeHeader ? handleRangeResponse(networkResp, rangeHeader) : networkResp;
          }
          return networkResp;
        } catch (err) {
          return new Response("", { status: 404, statusText: "Offline audio unavailable" });
        }
      })()
    );
    return;
  }

  // App shell code (HTML, JS, CSS): Network-first with Cache fallback so updates apply immediately
  const isShellCode =
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith("/");

  if (isShellCode) {
    event.respondWith(
      fetch(req)
        .then((networkResp) => {
          if (networkResp && networkResp.ok && networkResp.status === 200) {
            const clone = networkResp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, clone)).catch(() => {});
          }
          return networkResp;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Static shell assets (images, fonts, manifests): Cache-first with network fallback
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp && resp.ok && resp.status === 200) {
          caches.open(SHELL_CACHE).then((c) => c.put(req, resp.clone())).catch(() => {});
        }
        return resp;
      });
    })
  );
});
