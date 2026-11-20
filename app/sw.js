// Offline support: app files are served network-first (updates show up when online),
// the OCR engine is cache-first (large and versioned), the card data network-first.
const CACHE = "card-scanner-v39";
const SHELL = ["./", "index.html", "style.css", "theme-galaxy.css", "app.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/logo.png", "icons/brands/cardmarket.png", "icons/brands/vinted.png", "data/cards.json"];
// ort-wasm.wasm (no SIMD) is only fetched by old phones, so it is cached on first use instead.
const VENDOR = ["vendor/ort/ort.min.js", "vendor/ort/ort-wasm-simd.wasm", "vendor/paddle/det.onnx", "vendor/paddle/rec.onnx", "vendor/paddle/keys.txt", "vendor/supabase/supabase.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...VENDOR]).then(() => c.add("data/riftbound.json").catch(() => {}))).then(() => self.skipWaiting()));
});
// Card thumbnails get their own cache, kept across app updates.
const IMG_CACHE = "card-scanner-img";
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const cacheFirst = (req, name) => caches.match(req).then((r) => r || fetch(req).then((res) => {
  if (res.ok) { const cp = res.clone(); caches.open(name).then((c) => c.put(req, cp)); }
  return res;
}));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/img/")) { e.respondWith(cacheFirst(e.request, IMG_CACHE)); return; }
  if (url.pathname.includes("/vendor/")) { e.respondWith(cacheFirst(e.request, CACHE)); return; }
  // no-cache: always ask GitHub Pages whether the file changed (its HTTP cache lasts 10 min).
  e.respondWith(fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }).then((res) => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});
