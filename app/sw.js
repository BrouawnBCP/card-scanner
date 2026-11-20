// Offline support: app files are served network-first (updates show up when online),
// the OCR engine is cache-first (large and versioned), the card data network-first.
const CACHE = "card-scanner-v11";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "data/cards.json"];
// ort-wasm.wasm (no SIMD) is only fetched by old phones, so it is cached on first use instead.
const VENDOR = ["vendor/ort/ort.min.js", "vendor/ort/ort-wasm-simd.wasm", "vendor/paddle/det.onnx", "vendor/paddle/rec.onnx", "vendor/paddle/keys.txt", "vendor/supabase/supabase.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...VENDOR])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/vendor/")) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return res; })));
    return;
  }
  // no-cache: always ask GitHub Pages whether the file changed (its HTTP cache lasts 10 min).
  e.respondWith(fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }).then((res) => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
});
