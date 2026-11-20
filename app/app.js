/* Card Scanner — reconnaissance du code de set sur le téléphone (PaddleOCR + ONNX Runtime), sans serveur. */
const APP_VERSION = "31";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REGION = { FR: "French", F: "French", EN: "English", E: "English", DE: "German", G: "German", D: "German", IT: "Italian", I: "Italian", SP: "Spanish", S: "Spanish", ES: "Spanish", PT: "Portuguese", P: "Portuguese" };
const LANGS = ["French", "English", "German", "Italian", "Spanish", "Portuguese"];
const LANG_SHORT = { French: "FR", English: "EN", German: "DE", Italian: "IT", Spanish: "ES", Portuguese: "PT" };
const COND = ["MT", "NM", "EX", "GD", "LP", "PL", "PO"];
const eur = (n) => n == null ? "" : n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

/* ================= persistence ================= */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const settings = Object.assign({ cond: "NM", lang: "French", comment: "", priceTrend: false, sound: true, debug: false, torch: false, gem: 5 }, store.get("cs-settings", {}));

/* ----- sessions: one list per scanning session ----- */
function newSession(itemsIn = []) {
  const d = new Date();
  return { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), items: itemsIn,
    name: `${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` };
}
// Sessions live in IndexedDB (room for many thousands of cards; localStorage holds about 5 MB).
// Older versions kept them in localStorage: they are read once from there, then moved.
const idb = {
  db: null,
  open() {
    return (this.db ||= new Promise((res, rej) => {
      const r = indexedDB.open("card-scanner", 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" }); // card photos (v29)
      };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); },
  async photos() { const db = await this.open(); return new Promise((res, rej) => { const q = db.transaction("photos").objectStore("photos").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); },
  async putPhoto(p) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("photos", "readwrite"); tx.objectStore("photos").put(p); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); },
  async delPhoto(id) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction("photos", "readwrite"); tx.objectStore("photos").delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
};
let sessions = store.get("cs-sessions", null);
if (!Array.isArray(sessions) || !sessions.length) sessions = [newSession(store.get("cs-items", []))]; // migrate the single list of v1–v4
let current = sessions.find((s) => s.id === store.get("cs-current", "")) || sessions[0];
let items = current.items;
let dataReady = false; // true once the sessions saved in IndexedDB are loaded
async function loadSessions() {
  try {
    const saved = await idb.get("sessions");
    if (Array.isArray(saved) && saved.length) {
      sessions = saved;
      current = sessions.find((s) => s.id === store.get("cs-current", "")) || sessions[0];
      items = current.items;
    } else {
      await idb.set("sessions", sessions); // first run of this version: move the localStorage copy
    }
    try { localStorage.removeItem("cs-sessions"); localStorage.removeItem("cs-items"); } catch {}
  } catch (e) { console.warn("IndexedDB unavailable, staying on localStorage", e); idbBroken = true; }
  dataReady = true;
  renderList(); renderSessionBar(); renderLast(); if (view === "home") renderHome();
  scheduleSync(300);
}
let idbBroken = false, persistT = null;
function saveItems() {
  current.items = items; current.updatedAt = Date.now();
  persist();
  renderList(); renderSessionBar();
  scheduleSync();
}
function persist() {
  store.set("cs-current", current.id);
  if (idbBroken) { if (!store.set("cs-sessions", sessions)) toast("Impossible d'enregistrer sur ce téléphone. Exporte ta liste."); return; }
  clearTimeout(persistT);
  persistT = setTimeout(() => idb.set("sessions", sessions).catch((e) => { console.warn(e); toast("Impossible d'enregistrer sur ce téléphone. Exporte ta liste."); }), 250);
}
// write immediately when the app is hidden or closed
document.addEventListener("visibilitychange", () => { if (document.hidden && persistT && !idbBroken) { clearTimeout(persistT); persistT = null; idb.set("sessions", sessions).catch(() => {}); } });
function switchSession(s) { current = s; items = s.items; lastAdded = null; saveItems(); renderLast(); }
function startNewSession() {
  if (!items.length) { toast("Cette session est encore vide : continue de scanner dedans."); return; }
  const s = newSession(); sessions.unshift(s); switchSession(s);
  toast("Nouvelle session commencée"); bump($("sessionBar"));
}
navigator.storage?.persist?.().catch(() => {});

/* ================= card data ================= */
let DATA = null, PREFIXES = null;
async function loadData() {
  try {
    const r = await fetch("data/cards.json");
    DATA = await r.json();
    PREFIXES = new Set(Object.keys(DATA.prints).map((k) => k.slice(0, k.indexOf("-"))));
    $("dataInfo").textContent = `Version ${APP_VERSION} · Base : ${DATA.cards.length.toLocaleString("fr-FR")} cartes · cotes Cardmarket du ${new Date(DATA.v).toLocaleDateString("fr-FR")}`;
    renderList();
  } catch {
    setStatus("La base de cartes n'a pas pu être chargée. Vérifie ta connexion puis relance l'appli.");
  }
}
function cmPrice(cm) {
  if (!DATA || !cm) return null;
  const ids = Array.isArray(cm) ? cm : [cm];
  const t = ids.map((i) => DATA.prices[i]?.[0]).filter((x) => x != null);
  if (!t.length) return null;
  return { lo: Math.min(...t), hi: Math.max(...t) };
}
const priceText = (p) => !p ? "" : p.lo === p.hi ? eur(p.lo) : `${eur(p.lo)} – ${eur(p.hi)}`;
function candidatesFor(key) {
  const seen = new Set(), out = [];
  for (const e of DATA.prints[key] || []) {
    const id = e[0] + "|" + e[2];
    if (seen.has(id)) continue; seen.add(id);
    out.push({ card: e[0], set: DATA.sets[e[1]], rarity: e[2], cm: e[3] || 0 });
  }
  return out;
}
function applyCandidate(it, c) {
  it.card = c.card; it.nameEN = DATA.cards[c.card][0]; it.nameFR = DATA.cards[c.card][1] || it.nameEN;
  it.set = c.set; it.rarity = c.rarity; it.cm = c.cm;
}
/** Build an item from a matched code {key, code, region}. */
function makeItem(m, extra = {}) {
  const cands = candidatesFor(m.key);
  const it = {
    id: uid(), createdAt: Date.now(), key: m.key, code: m.code, prefix: m.key.split("-")[0], cn: m.key.split("-")[1],
    lang: REGION[m.region] || settings.lang, firstEd: false, condition: settings.cond, comment: settings.comment,
    qty: 1, price: "", cands, ...extra,
  };
  applyCandidate(it, cands[0]);
  if (cands.length > 1) { it.rarity = ""; it.cm = [...new Set(cands.flatMap((c) => Array.isArray(c.cm) ? c.cm : c.cm ? [c.cm] : []))]; }
  return it;
}

/* ================= code matching (OCR text -> real set code) ================= */
const L2D = { O: "0", Q: "0", D: "0", U: "0", I: "1", L: "1", J: "1", T: "7", Z: "2", S: "5", B: "8", G: "6", A: "4" };
const D2L = { 0: "O", 1: "I", 5: "S", 8: "B", 2: "Z", 6: "G", 4: "A", 7: "T" };
const REGION_FIX = { EH: "EN", FN: "EN", EW: "EN", ER: "FR", PR: "FR", FA: "FR", FB: "FR", DF: "DE", OE: "DE", IF: "IT", SF: "SP", SR: "SP", PF: "PT" };
function prefixVariants(p) {
  if (PREFIXES.has(p)) return [p];
  const opts = [...p].map((ch) => { const s = new Set([ch]); if (L2D[ch]) s.add(L2D[ch]); if (D2L[ch]) s.add(D2L[ch]); return [...s]; });
  const out = [];
  (function rec(i, acc, changes) {
    if (out.length > 3) return;
    if (i === opts.length) { if (PREFIXES.has(acc)) out.push(acc); return; }
    for (const c of opts[i]) { const ch = c !== p[i]; if (ch && changes >= 2) continue; rec(i + 1, acc + c, changes + (ch ? 1 : 0)); }
  })(0, "", 0);
  return out;
}
// Letters OCR may return in place of a digit (Z is ambiguous: 2 or 7).
const L2DS = { O: ["0"], Q: ["0"], D: ["0"], U: ["0"], I: ["1"], L: ["1"], J: ["1"], T: ["7"], Z: ["2", "7"], S: ["5"], B: ["8"], G: ["6"], A: ["4"] };
function parseSuffix(s) {
  if (s.length < 3 || s.length > 6) return null;
  let nums = [""], clean = true;
  for (const c of s.slice(-3)) {
    const opts = /\d/.test(c) ? [c] : (L2DS[c] || []);
    if (!opts.length) return null;
    if (!/\d/.test(c)) clean = false;
    nums = nums.flatMap((n) => opts.map((o) => n + o));
  }
  const raw = s.slice(0, -3);
  let reg = raw.replace(/\d/g, (c) => D2L[c] || "");
  if (reg.length > 2) reg = reg.slice(-2);
  if (!REGION[reg] && REGION_FIX[reg]) reg = REGION_FIX[reg];
  if (reg !== raw || !REGION[reg]) clean = false;
  return { region: REGION[reg] ? reg : "", nums, clean };
}
function tryCode(pre, suf, out) {
  pre = pre.replace(/[^A-Z0-9]/g, ""); suf = suf.replace(/[^A-Z0-9]/g, "");
  if (pre.length < 2 || pre.length > 5) return;
  const sx = parseSuffix(suf); if (!sx) return;
  const found = [];
  for (const pv of prefixVariants(pre)) for (const n of sx.nums) {
    const key = pv + "-" + n;
    if (DATA.prints[key]) found.push({ key, code: `${pv}-${sx.region}${n}`, region: sx.region });
  }
  // Several real codes fit the same blurry read: flag them so a single read never decides.
  // "exact": read as printed, no character had to be corrected, so one read is enough.
  for (const f of found) if (!out.some((o) => o.key === f.key))
    out.push({ ...f, unsure: found.length > 1, exact: found.length === 1 && sx.clean && f.key.startsWith(pre + "-") });
}
/** All real set codes found in a block of OCR text, best first. */
function matchAll(text) {
  if (!DATA) return [];
  const out = [];
  const lines = text.toUpperCase().replace(/[—–_~=]/g, "-").split(/\n+/);
  for (const line of lines) {
    const toks = line.replace(/[^A-Z0-9\- ]/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const variants = [toks[i]];
      if (toks[i + 1]) variants.push(toks[i] + toks[i + 1]);
      for (const s of variants) {
        const j = s.indexOf("-");
        if (j > 0) { tryCode(s.slice(0, j), s.slice(j + 1).replace(/-/g, ""), out); continue; }
        if (s.length >= 7 && s.length <= 11) for (let k = 2; k <= 5; k++) tryCode(s.slice(0, k), s.slice(k), out);
      }
    }
  }
  return out;
}
function matchManual(raw) {
  const s = String(raw).toUpperCase().replace(/\s+/g, "");
  const m = s.match(/^([A-Z0-9]{2,5})-([A-Z]{0,2})(\d{1,3})$/);
  if (m) {
    const key = m[1] + "-" + m[3].padStart(3, "0");
    if (DATA.prints[key]) return { key, code: `${m[1]}-${m[2]}${m[3].padStart(3, "0")}`, region: REGION[m[2]] ? m[2] : "" };
  }
  return matchAll(s)[0] || null;
}

/* ================= OCR (PaddleOCR via ONNX Runtime, on the phone) ================= */
let engineP = null;
function getEngine() {
  if (!engineP) {
    engineP = (async () => {
      ort.env.wasm.wasmPaths = new URL("vendor/ort/", location.href).href;
      ort.env.wasm.numThreads = 1;
      const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      const [det, rec, keysTxt] = await Promise.all([
        ort.InferenceSession.create("vendor/paddle/det.onnx", opt),
        ort.InferenceSession.create("vendor/paddle/rec.onnx", opt),
        fetch("vendor/paddle/keys.txt").then((r) => r.text()),
      ]);
      const keys = keysTxt.split(/\r?\n/); if (keys.at(-1) === "") keys.pop(); keys.push(" ");
      return { det, rec, keys };
    })().catch((e) => { engineP = null; throw e; });
  }
  return engineP;
}
/** Copy a region of an image/video into a canvas, scaled so its longest side is at most `max`. */
function grab(src, x, y, w, h, max = 960) {
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high";
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}
/** Text detection (DBNet): boxes of text in canvas `c`, in its pixel coordinates. */
async function detectText(c) {
  const { det } = await getEngine();
  const W = Math.max(32, Math.round(c.width / 32) * 32), H = Math.max(32, Math.round(c.height / 32) * 32);
  const t = document.createElement("canvas"); t.width = W; t.height = H;
  const g = t.getContext("2d", { willReadFrequently: true }); g.drawImage(c, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, n = W * H, f = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[k * n + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor("float32", f, [1, 3, H, W]) });
  const p = out[det.outputNames[0]].data;
  // connected components of the probability map
  const seen = new Uint8Array(n), boxes = [], stack = [];
  for (let i = 0; i < n; i++) {
    if (seen[i] || p[i] < 0.3) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0, sum = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % W, y = (j / W) | 0;
      cnt++; sum += p[j]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [j - 1, j + 1, j - W, j + W]) {
        if (k < 0 || k >= n || seen[k] || p[k] < 0.3) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === W - 1)) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    if (cnt < 12 || sum / cnt < 0.5) continue;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, off = (bw * bh * 1.5) / (2 * (bw + bh)); // DB "unclip"
    const sx = c.width / W, sy = c.height / H;
    const bx = Math.max(0, x0 - off) * sx, by = Math.max(0, y0 - off) * sy;
    boxes.push({ x: bx, y: by, w: Math.min(c.width, (x1 + off + 1) * sx) - bx, h: Math.min(c.height, (y1 + off + 1) * sy) - by });
  }
  return boxes;
}
/** Text recognition (CRNN + CTC) of one box of canvas `c`. */
async function recognize(c, b) {
  const { rec, keys } = await getEngine();
  const H = 48, W = Math.min(960, Math.max(48, Math.round(b.w * H / b.h)));
  const t = document.createElement("canvas"); t.width = W; t.height = H;
  const g = t.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high";
  g.drawImage(c, b.x, b.y, b.w, b.h, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, n = W * H, f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) f[k * n + i] = d[i * 4 + k] / 127.5 - 1;
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor("float32", f, [1, 3, H, W]) });
  const o = out[rec.outputNames[0]], [, T, C] = o.dims;
  let s = "", prev = 0;
  for (let i = 0; i < T; i++) {
    let bi = 0, bv = -1; for (let k = 0; k < C; k++) { const v = o.data[i * C + k]; if (v > bv) { bv = v; bi = k; } }
    if (bi !== 0 && bi !== prev) s += keys[bi - 1] ?? "";
    prev = bi;
  }
  return s;
}
/** All set codes found in canvas `c` (detection + recognition of every likely line). */
async function readCodes(c, { textH = 0, maxLines = 8, prefer = null } = {}) {
  const raw = (await detectText(c)).filter((b) => b.w > b.h * 2);
  // detected boxes are padded ("unclip"): about 2.5× the height of the letters
  let boxes = textH ? raw.filter((b) => b.h > textH * 0.6 && b.h < textH * 4.5) : raw;
  if (prefer) boxes.sort((a, b) => prefer(a) - prefer(b));
  const lines = [];
  for (const b of boxes.slice(0, maxLines)) {
    const text = await recognize(c, b);
    const matches = matchAll(text.toUpperCase());
    lines.push({ box: b, text, matches });
    if (matches.some((m) => !m.unsure) && prefer) break;
  }
  return { boxes, raw, lines, matches: lines.flatMap((l) => l.matches) };
}

/* ================= camera scanning ================= */
const video = $("video");
let stream = null, scanning = false, wantScan = false, audioCtx = null, wakeLock = null;
let reads = [], last = null /* {sig} */, changed = true, changedHits = 0;

function guideInVideo() {
  const st = $("stage").getBoundingClientRect(), gr = $("guide").getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(st.width / vw, st.height / vh);
  const ox = (st.width - vw * s) / 2, oy = (st.height - vh * s) / 2;
  return { x: (gr.left - st.left - ox) / s, y: (gr.top - st.top - oy) / s, w: gr.width / s, h: gr.height / s };
}
const sigCanvas = document.createElement("canvas"); sigCanvas.width = 24; sigCanvas.height = 35;
function signature(r) {
  const g = sigCanvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, 24, 35);
  const d = g.getImageData(0, 0, 24, 35).data, out = new Uint8Array(24 * 35);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] + d[i + 1] + d[i + 2]) / 3;
  return out;
}
const sigDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };

// iOS home-screen apps often fail to hand the camera back once it has been released. So leaving the
// Scanner only pauses reading and keeps the camera open for a while; it is released after 2 minutes
// away, when the app goes to the background, or when the person presses Pause.
const KEEP_CAMERA_MS = 120000;
let starting = false, loopToken = 0, releaseTimer = null;
const liveTrack = () => { const t = stream?.getVideoTracks()[0]; return t && t.readyState === "live" ? t : null; };
function resetVideo() {
  try { video.pause(); } catch {}
  video.srcObject = null; video.removeAttribute("src");
  try { video.load(); } catch {}
}
async function waitForFrames(ms = 4000) {
  const t0 = Date.now();
  while (!video.videoWidth && Date.now() - t0 < ms) await sleep(100);
  if (!video.videoWidth) throw Object.assign(new Error("no frames"), { name: "NoFrames" });
}
async function startCamera() {
  if (!DATA) { toast("La base de cartes charge encore…"); return; }
  if (starting) return;
  starting = true;
  clearTimeout(releaseTimer);
  try {
    if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
    audioCtx?.resume?.();
    if (liveTrack()) {
      // camera still open (we only left the Scanner for a moment): just resume
      if (video.srcObject !== stream) video.srcObject = stream;
      await video.play().catch(() => {});
      await waitForFrames(1500).catch(async () => { await openCamera(); });
    } else {
      await openCamera();
    }
  } catch (e) {
    console.warn(e);
    stopCamera(false);
    setStatus(e && e.name === "NotAllowedError"
      ? "Accès à la caméra refusé. Autorise-le dans Réglages › Safari › Caméra."
      : "La caméra ne répond pas. Appuie sur le bouton pour réessayer.");
    starting = false; return;
  }
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  $("torchBtn").disabled = false;
  if (settings.torch && !torchOn) setTorch(true, true);
  try {
    setStatus("Chargement du moteur de lecture (une seule fois)…");
    await getEngine();
  } catch (e) {
    console.warn(e); stopCamera(false); starting = false;
    setStatus("Le moteur de lecture n'a pas pu démarrer. Vérifie ta connexion puis réessaie."); return;
  }
  starting = false;
  if (view && view !== "scan") { pauseScan(); return; } // the person left while the camera was starting
  wantScan = true;
  scanning = true; reads = []; changed = true;
  setShutter(true);
  setStatus("Place une carte dans le cadre");
  loop();
}
async function openCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null; resetVideo();
  stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
  torchOn = false;
  stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (scanning) { stopCamera(true); setStatus("La caméra a été coupée. Appuie sur le bouton pour la relancer."); } });
  video.srcObject = stream;
  await video.play();
  await waitForFrames();
  try { const tr = stream.getVideoTracks()[0]; const caps = tr.getCapabilities?.() || {}; if (caps.focusMode?.includes("continuous")) await tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
}
/** Leaving the Scanner: stop reading, keep the camera open for a quick return. */
function pauseScan() {
  scanning = false; loopToken++;
  try { video.pause(); } catch {}
  if (torchOn) { const keep = settings.torch; setTorch(false, true).then(() => { settings.torch = keep; store.set("cs-settings", settings); }); }
  try { wakeLock?.release(); } catch {} wakeLock = null;
  setShutter(false);
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => { if (!scanning) stopCamera(true); }, KEEP_CAMERA_MS);
}
function setShutter(on) {
  const b = $("startBtn"); b.classList.toggle("on", on);
  b.setAttribute("aria-label", on ? "Mettre le scan en pause" : "Démarrer le scan");
  $("stage").classList.toggle("live", on);
  if (!on) { failStreak = 0; showHint(null); }
}
/* ----- flash (torch). iOS 17+ accepts the "torch" constraint but may not report it back, so we keep our own state. */
let torchOn = false;
async function setTorch(on, quiet = false) {
  const tr = liveTrack();
  if (!tr) return;
  try {
    await tr.applyConstraints({ advanced: [{ torch: on }] });
    torchOn = on;
  } catch {
    torchOn = false;
    if (!quiet) toast("Le flash n'est pas disponible ici (iPhone récent avec iOS 17 ou plus, dans Safari).");
  }
  settings.torch = torchOn && on; store.set("cs-settings", settings);
  $("torchBtn").classList.toggle("on", torchOn);
  $("torchBtn").setAttribute("aria-pressed", String(torchOn));
}
$("torchBtn").addEventListener("click", () => setTorch(!torchOn));
function stopCamera(keepWanted = false) {
  // releasing the camera turns the flash off; settings.torch is kept so it comes back on next start
  clearTimeout(releaseTimer); loopToken++;
  torchOn = false; $("torchBtn").classList.remove("on"); $("torchBtn").disabled = true;
  scanning = false; if (!keepWanted) wantScan = false;
  stream?.getTracks().forEach((t) => t.stop()); stream = null; resetVideo();
  try { wakeLock?.release(); } catch {} wakeLock = null;
  setShutter(false);
  if (!keepWanted) setStatus("En pause");
}
async function loop() {
  const me = ++loopToken; // a newer loop (after a quick pause/resume) replaces this one
  while (scanning && me === loopToken) {
    try { await scanFrame(); } catch (e) { console.warn(e); await sleep(300); }
    await sleep(0);
  }
}
// The lower part of the card holds the set code (right, under the artwork; bottom-left on Pendulum
// cards) and the "1st Edition" mention. Reading this whole area tolerates a badly placed card.
const LOWER = { y: 0.56, h: 0.46, x: -0.04, w: 1.08 };
let sawEmpty = true; // a frame without any readable code since the last card was added

/* ----- Pendulum cards: set code at the bottom left, under the text box ----- */
let pendTick = 0;
async function readBottomLeft(r) {
  try {
    const x0 = Math.max(0, r.x - r.w * 0.03), y0 = Math.max(0, r.y + r.h * 0.76);
    const w = Math.min(video.videoWidth - x0, r.w * 0.62), h = Math.min(video.videoHeight - y0, r.h * 0.3);
    if (w < 20 || h < 20) return { matches: [], lines: [] };
    const strip = grab(video, x0, y0, w, h, 1280);
    // short lines first (the code), long ones (effect text) last
    const prefer = (b) => (b.w / strip.width > 0.6 ? 1 : 0) + Math.abs((b.y + b.h / 2) / strip.height - 0.55);
    const res = await readCodes(strip, { prefer, maxLines: 4 });
    return { matches: res.matches, lines: [] };
  } catch (e) { console.warn(e); return { matches: [], lines: [] }; }
}

/* ----- scanning help: why a card is not read ----- */
let failStreak = 0;
const statCanvas = document.createElement("canvas");
/** Brightness, glare and sharpness of the lower part of the card (on a small copy, fast). */
function frameStats(zone) {
  const w = 200, h = Math.max(8, Math.round(zone.height * w / zone.width));
  statCanvas.width = w; statCanvas.height = h;
  const g = statCanvas.getContext("2d", { willReadFrequently: true }); g.drawImage(zone, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, n = w * h, L = new Float32Array(n);
  let sum = 0, sq = 0, hot = 0;
  for (let i = 0; i < n; i++) { const y = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; L[i] = y; sum += y; sq += y * y; if (y > 245) hot++; }
  const std = Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2));
  let s1 = 0, s2 = 0, m = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w];
    s1 += v; s2 += v * v; m++;
  }
  return { mean: sum / n, std, glare: hot / n, sharp: s2 / m - (s1 / m) ** 2 };
}
const HINTS = {
  dark: ["Pas assez de lumière", "Active le flash ⚡ ou rapproche-toi d'une source de lumière."],
  glare: ["Reflet sur la carte", "Incline légèrement la carte ou le téléphone. Si la carte brille beaucoup, coupe le flash."],
  blur: ["Image floue", "Tiens le téléphone immobile, à 15–25 cm de la carte, le temps que la mise au point se fasse."],
  far: ["Carte trop loin", "Rapproche le téléphone : la carte doit remplir le cadre doré."],
  close: ["Carte trop près", "Éloigne un peu le téléphone : toute la carte doit tenir dans le cadre."],
  empty: ["Aucune carte détectée", "Place une carte face visible dans le cadre doré."],
  nocode: ["Code de set illisible", "Vérifie que le code (sous l'illustration, à droite, ex. MP20-FR167) est bien visible : pas de doigt, de reflet ou de sleeve opaque dessus."],
  unsure: ["Code incertain", "Garde la carte immobile une seconde, sans bouger le téléphone."],
};
function diagnose(zone, res, textH) {
  const st = frameStats(zone);
  if (st.mean < 60) return "dark";
  if (st.glare > 0.06) return "glare";
  // nothing readable: a flat picture means no card at all, a contrasted but soft one means a blurry card
  const all = res.raw || res.boxes;
  if (!all.length) return st.std < 16 ? "empty" : st.sharp < 18 ? "blur" : "empty";
  // detected text lines are about 2.5× the letter height: compare every line found (even the ones too big
  // or too small to be read) with the size expected for a card that fills the frame
  const hs = all.map((b) => b.h).sort((a, b) => a - b), med = hs[hs.length >> 1], ratio = med / (2.5 * textH);
  window.__diag = { ratio, hs, textH, ...st }; // for troubleshooting from the console
  // measured on a card that fills the frame: ratio ≈ 0.6 with several lines found
  if (ratio < 0.42) return "far";
  if (ratio > 1.3) return "close";
  if (st.sharp < 18) return "blur";
  if (res.matches.some((x) => x.unsure)) return "unsure";
  return "nocode";
}
let hintShown = null;
function showHint(kind) {
  if (kind === hintShown) return;
  hintShown = kind;
  const box = $("scanHint");
  if (!kind) { box.hidden = true; return; }
  const [title, text] = HINTS[kind];
  box.innerHTML = `<span class="hint-ico">${ico(kind === "dark" ? "flash" : kind === "far" || kind === "close" ? "scan" : "card")}</span><div><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;
  box.hidden = false;
}
async function scanFrame() {
  if (!video.videoWidth) { await sleep(100); return; }
  const r = guideInVideo();
  const sig = signature(r);
  if (!changed) {
    // The card just added is still in front of the camera: only watch (cheaply) for it to move away.
    if (sigDiff(sig, last.sig) > 22) { if (++changedHits >= 2) { changed = true; reads = []; sawEmpty = false; setStatus("Recherche du code…"); } }
    else changedHits = 0;
    if (!changed) {
      // …and look a few more times for a "1st Edition" mention missed on the first read
      if (last.edPending > 0 && last.itemId) {
        last.edPending--;
        const token = loopToken;
        const ed = await readEdition(r, r.y + r.h * last.edFrom);
        if (token === loopToken && ed.ed) { last.edPending = 0; markFirstEd(last.itemId); }
      } else await sleep(120);
      return;
    }
  }
  const zx = Math.max(0, r.x + r.w * LOWER.x), zy = Math.max(0, r.y + r.h * LOWER.y);
  const zw = Math.min(video.videoWidth - zx, r.w * LOWER.w), zh = Math.min(video.videoHeight - zy, r.h * LOWER.h);
  const zone = grab(video, zx, zy, zw, zh, 960);
  const k = zone.height / zh, textH = r.h * 0.017 * k;
  // Read first the lines that look like a set code: a short line either under the artwork on the right
  // (most cards) or at the bottom left, under the text box (Pendulum cards). Long lines are effect text.
  const prefer = (b) => {
    const cy = (b.y + b.h / 2) / zone.height, cx = (b.x + b.w / 2) / zone.width, wide = b.w / zone.width > 0.5 ? 0.6 : 0;
    const normal = Math.abs(cy - 0.3) + (b.x + b.w > zone.width * 0.7 ? 0 : 0.4);
    const pendulum = Math.max(0, 0.6 - cy) + (cx < 0.45 ? 0 : 0.5);
    return Math.min(normal, pendulum) + wide;
  };
  const token = loopToken;
  const res = await readCodes(zone, { textH, prefer, maxLines: 7 });
  if (!scanning || token !== loopToken) return;
  // Pendulum cards print the code small, bottom left: every other failed frame, read that corner at full resolution.
  if (!res.matches.some((x) => !x.unsure) && (pendTick++ % 2 === 0)) {
    const extra = await readBottomLeft(r);
    if (!scanning || token !== loopToken) return;
    res.matches.push(...extra.matches); res.lines.push(...extra.lines);
  }
  if (settings.debug) showDebug(zone, res, r);
  const m = res.matches.find((x) => !x.unsure) || null;
  reads.push(m ? m.key : null); if (reads.length > 4) reads.shift();
  if (!m) {
    if (!res.boxes.length || res.lines.every((l) => !l.text)) sawEmpty = true;
    setStatus("Recherche du code…");
    // after a few failed reads, tell the person what is probably wrong
    if (++failStreak >= 3) showHint(diagnose(zone, res, textH));
    return;
  }
  failStreak = 0; showHint(null);
  // Same code as the card just added and the camera never saw the card leave: it is the same card being moved.
  if (last && m.key === last.key && !sawEmpty) { setStatus(`Déjà ajoutée : <span class="code">${esc(m.code)}</span> — présente la suivante`); changed = false; last.sig = sig; return; }
  const hits = reads.filter((k) => k === m.key).length;
  if (m.exact || hits >= 2) {
    // The edition mention is the lowest line on the left, below the code line: read that strip on its own.
    const line = res.lines.find((l) => l.matches.some((x) => x.key === m.key));
    const fromY = line ? zy + (line.box.y + line.box.h) / k : r.y + r.h * 0.76;
    const ed = await readEdition(r, fromY);
    const it = makeItem(m, { firstEd: ed.ed === true });
    const shot = camMode === "photo" ? capturePhoto(r) : null; // picture taken right away, while the card is still in the frame
    commit(it, "scan");
    if (shot) attachPhoto(shot, it, lastAdded?.id);
    last = { sig, key: m.key, itemId: lastAdded?.id, edPending: ed.ed ? 0 : 3, edFrom: (fromY - r.y) / r.h };
    changed = false; changedHits = 0; reads = []; sawEmpty = false;
    celebrate(it);
    setStatus(`Ajoutée${shot ? " + photo" : ""} : <span class="code">${esc(m.code)}</span>${ed.ed ? " · 1re édition" : ""} — présente la suivante`);
  } else setStatus(`Lu : <span class="code">${esc(m.code)}</span> — vérification…`);
}
/* ----- "1st Edition" mention: printed bottom-left, next to the 8-digit passcode ----- */
// 1st Edition · 1re/1ère Édition · 1. Auflage · 1a Edizione · 1a Edición · 1ª Edição — never "Limited Edition".
function isEditionText(t) {
  const s = String(t).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/g, "");
  if (!s || /limit|imite|limita/.test(s)) return false; // Limited Edition / Édition Limitée / Edizione Limitata…
  return /dition|auflage|edizion|edicion|edicao|1st|1re|1ere/.test(s);
}
async function readEdition(r, fromY) {
  try {
    const x0 = Math.max(0, r.x - r.w * 0.03), w = Math.min(video.videoWidth - x0, r.w * 0.62);
    const y0 = Math.max(0, fromY), y1 = Math.min(video.videoHeight, r.y + r.h * 1.06);
    if (y1 - y0 < r.h * 0.05) return { ed: null, text: "" };
    const strip = grab(video, x0, y0, w, y1 - y0, 1280); // full resolution: the mention is tiny
    const boxes = (await detectText(strip))
      .filter((b) => b.w > b.h * 1.8 && b.x < strip.width * 0.55)
      .sort((a, b) => (b.y + b.h) - (a.y + a.h)).slice(0, 3);   // lowest lines first
    const texts = [];
    for (const b of boxes) {
      const t = await recognize(strip, b); texts.push(t);
      if (isEditionText(t)) { debugEdition(strip, texts, true); return { ed: true, text: texts.join(" | ") }; }
    }
    debugEdition(strip, texts, false);
    return { ed: boxes.length ? false : null, text: texts.join(" | ") };
  } catch (e) { console.warn(e); return { ed: null, text: "" }; }
}
function debugEdition(strip, texts, ed) {
  if (!settings.debug) return;
  const c = $("debugEdCanvas"); c.width = strip.width; c.height = strip.height; c.getContext("2d").drawImage(strip, 0, 0);
  $("debugEdText").textContent = `Mention d'édition lue : ${texts.join(" ⏎ ") || "(aucun texte)"} → ${ed ? "1re édition ✔" : "non trouvée"}`;
  $("debugEd").hidden = false;
}
/** A later read found "1st Edition" on the card just added: move one copy to its 1st-edition line. */
function markFirstEd(id) {
  const it = items.find((x) => x.id === id); if (!it || it.firstEd) return;
  if (it.qty > 1) {
    it.qty -= 1;
    const copy = { ...JSON.parse(JSON.stringify(it)), id: uid(), qty: 1, firstEd: true, createdAt: Date.now() };
    const twin = items.find((x) => x !== it && mergeKey(x) === mergeKey(copy));
    if (twin) { twin.qty += 1; lastAdded = { id: twin.id, merged: true }; } else { items.unshift(copy); lastAdded = { id: copy.id, merged: false }; }
  } else {
    it.firstEd = true;
    const twin = items.find((x) => x !== it && mergeKey(x) === mergeKey(it));
    if (twin) { twin.qty += it.qty; items = items.filter((x) => x !== it); lastAdded = { id: twin.id, merged: true }; }
  }
  if (last) last.itemId = lastAdded?.id;
  saveItems(); renderLast(); toast("1re édition détectée");
}
function showDebug(zone, res, r) {
  const c = $("debugCanvas"); c.width = zone.width; c.height = zone.height;
  const g = c.getContext("2d"); g.drawImage(zone, 0, 0);
  g.lineWidth = 3;
  for (const b of res.boxes) { g.strokeStyle = "rgba(240,162,74,.9)"; g.strokeRect(b.x, b.y, b.w, b.h); }
  for (const l of res.lines) { g.strokeStyle = l.matches.length ? "#55c993" : "#3b82f6"; g.strokeRect(l.box.x, l.box.y, l.box.w, l.box.h); }
  $("debugText").textContent = `Lignes lues : ${res.lines.map((l) => l.text || "∅").join(" ⏎ ") || "(aucune)"}\nCode(s) reconnu(s) : ${res.matches.map((m) => m.code + (m.unsure ? " (incertain)" : "")).join(", ") || "aucun"}\nVidéo ${video.videoWidth}×${video.videoHeight} · carte ${Math.round(r.w)}×${Math.round(r.h)} px · ${res.boxes.length} zone(s) de texte`;
  $("debug").hidden = false;
}
/** Restart a one-shot CSS animation on an element. */
function bump(el, cls = "bump") { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
/** Visual feedback when a card is added: green frame, a ticket flying to the list, counter pop. */
/** A "pépite": a card whose Cardmarket price reaches the threshold set in Réglages. */
function gemPrice(it) {
  const p = cmPrice(it.cm), t = Number(settings.gem) || 0;
  return t > 0 && p && p.hi >= t ? p : null;
}
function celebrate(it) {
  bump($("guide"), "hit");
  const gem = gemPrice(it);
  const fly = document.createElement("div");
  fly.className = gem ? "fly gem" : "fly";
  fly.innerHTML = gem
    ? `<span class="gem-title">${ico("gem")} Pépite !</span><span>${esc(it.nameFR)}</span><span class="gem-price">${gem.lo === gem.hi ? esc(eur(gem.lo)) : `jusqu'à ${esc(eur(gem.hi))}`}</span>`
    : `<span class="code">${esc(it.code)}</span><span>${esc(it.nameFR)}</span>`;
  const st = stockOf(it);
  if (st) fly.innerHTML += `<span class="fly-stock">Déjà ${st.n} en stock</span>`;
  $("stage").append(fly);
  if (gem) { const burst = document.createElement("div"); burst.className = "burst"; $("stage").append(burst); setTimeout(() => burst.remove(), 1600); }
  fly.addEventListener("animationend", () => fly.remove());
  setTimeout(() => fly.remove(), gem ? 2600 : 1500);
  bump($("tabCount")); bump($("sessionCount"));
  gem ? chime() : beep();
}
/** Three rising notes for a pépite. */
function chime() {
  if (!settings.sound || !audioCtx) return;
  try {
    [988, 1319, 1976].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + i * 0.09;
      o.type = "triangle"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.36);
    });
  } catch {}
}
function beep() {
  if (!settings.sound || !audioCtx) return;
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 1320; g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.13);
  } catch {}
}
function setStatus(html) { $("status").innerHTML = html; }

/* ================= photo scanning ================= */
async function scanPhoto(file) {
  if (!DATA) { toast("La base de cartes charge encore…"); return; }
  setStatus("Analyse de la photo…");
  try {
    const bmp = await createImageBitmap(file);
    const found = [];
    for (const rot of [0, 90, 270]) {
      const src = rotate(bmp, rot);
      const res = await readCodes(src, { maxLines: 40 });
      for (const m of res.matches) if (!m.unsure && !found.some((f) => f.key === m.key)) found.push(m);
      if (found.length) break;
    }
    if (!found.length) { setStatus("Aucun code lu sur cette photo. Rapproche-toi du code de set."); toast("Aucun code trouvé"); return; }
    for (const m of found) commit(makeItem(m), "photo");
    setStatus(`${found.length} carte${found.length > 1 ? "s" : ""} ajoutée${found.length > 1 ? "s" : ""} depuis la photo`);
  } catch (e) { console.warn(e); setStatus("Cette photo n'a pas pu être analysée."); }
}
function rotate(bmp, deg) {
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement("canvas"); const g = c.getContext("2d");
  if (deg % 180) { c.width = h; c.height = w; } else { c.width = w; c.height = h; }
  g.translate(c.width / 2, c.height / 2); g.rotate(deg * Math.PI / 180); g.drawImage(bmp, -w / 2, -h / 2, w, h);
  return c;
}

/* ================= list operations ================= */
const mergeKey = (it) => [it.key, it.rarity, it.lang, it.firstEd, it.condition, it.comment].join("|");
let lastAdded = null; // {id, merged}
function commit(it, source) {
  const twin = items.find((x) => mergeKey(x) === mergeKey(it));
  if (twin) { twin.qty += 1; lastAdded = { id: twin.id, merged: true }; }
  else { items.unshift(it); lastAdded = { id: it.id, merged: false }; }
  saveItems(); renderLast();
  if (source === "manual") toast(`${(twin || it).nameFR} ajoutée`);
}
function undoLast() {
  if (!lastAdded) return;
  const it = items.find((x) => x.id === lastAdded.id);
  if (it) { if (lastAdded.merged && it.qty > 1) it.qty -= 1; else items = items.filter((x) => x.id !== it.id); }
  lastAdded = null; saveItems(); renderLast(); toast("Dernier ajout annulé");
}
function setRarity(it, rarity) {
  const c = (it.cands || []).find((x) => x.rarity === rarity); if (!c) return;
  applyCandidate(it, c);
  const twin = items.find((x) => x !== it && mergeKey(x) === mergeKey(it));
  if (twin) { twin.qty += it.qty; items = items.filter((x) => x !== it); if (lastAdded?.id === it.id) lastAdded = { id: twin.id, merged: true }; }
}
/** eBay France search on the printed set code (MP20-FR167): finds that exact print and language. */
const ebayLink = (it) => `https://www.ebay.fr/sch/i.html?_nkw=${encodeURIComponent(it.code || it.nameEN || "")}`;
/** Cardmarket and eBay logo buttons. */
const marketLinks = (it) => `<a class="brand-btn" href="${cmLink(it)}" target="_blank" rel="noopener" aria-label="Voir sur Cardmarket (${LANG_SHORT[it.lang] || "FR"})" title="Voir sur Cardmarket"><img src="icons/brands/cardmarket.png" alt="" width="22" height="22"><span class="brand-lang">${LANG_SHORT[it.lang] || ""}</span></a>`
  + `<a class="brand-btn" href="${ebayLink(it)}" target="_blank" rel="noopener" aria-label="Rechercher ${esc(it.code)} sur eBay" title="Rechercher sur eBay"><svg class="ebay-logo" viewBox="0 0 60 24" aria-hidden="true"><use href="#logo-ebay"/></svg></a>`
  + `<a class="brand-btn vinted" href="${vintedLink(it)}" target="_blank" rel="noopener" aria-label="Rechercher ${esc(it.nameFR || it.nameEN)} sur Vinted" title="Rechercher sur Vinted"><img src="icons/brands/vinted.png" alt="" width="24" height="24"></a>`;
/** Vinted France search on the card's name (sellers rarely write the set code there). */
const vintedLink = (it) => `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(String(it.nameFR || it.nameEN || "").replace(/^"+|"+$/g, ""))}`;
// Cardmarket language ids (offer filter "language=").
const CM_LANG = { English: 1, French: 2, German: 3, Spanish: 4, Italian: 5, Portuguese: 8 };
/** Product page with offers filtered on the card's language; a name search when the exact product is unknown. */
const cmLink = (it) => {
  const lang = CM_LANG[it.lang] || 2;
  return typeof it.cm === "number" && it.cm
    ? `https://www.cardmarket.com/fr/YuGiOh/Products?idProduct=${it.cm}&language=${lang}`
    : `https://www.cardmarket.com/fr/YuGiOh/Products/Search?searchString=${encodeURIComponent(it.nameEN || "")}&language=${lang}`;
};

/* ================= rendering ================= */
// Short rarity labels and the colour family of their badge.
const RAR = {
  "Common": ["C", "r-c"], "Rare": ["R", "r-r"], "Super Rare": ["SR", "r-sr"], "Ultra Rare": ["UR", "r-ur"],
  "Secret Rare": ["ScR", "r-scr"], "Prismatic Secret Rare": ["PScR", "r-scr"], "Ultimate Rare": ["UtR", "r-ur"],
  "Quarter Century Secret Rare": ["QCSR", "r-scr"], "Starlight Rare": ["StR", "r-scr"], "Platinum Secret Rare": ["PlScR", "r-scr"],
  "Collector's Rare": ["CR", "r-scr"], "Collectors Rare": ["CR", "r-scr"], "Ghost Rare": ["GR", "r-r"], "Gold Rare": ["GUR", "r-gold"],
  "Premium Gold Rare": ["PGR", "r-gold"], "Gold Secret Rare": ["GScR", "r-gold"], "Platinum Rare": ["PlR", "r-r"],
  "Starfoil Rare": ["SFR", "r-sr"], "Mosaic Rare": ["MSR", "r-sr"], "Shatterfoil Rare": ["SHR", "r-sr"], "Ultra Parallel Rare": ["UPR", "r-ur"],
  "Short Print": ["SP", "r-c"], "Super Short Print": ["SSP", "r-c"],
};
function rarBadge(r) {
  if (!r) return `<span class="rar r-q" title="Rareté à choisir">?</span>`;
  const [s, cls] = RAR[r] || [r.split(/\s+/).map((w) => w[0]).join("").slice(0, 4), "r-c"];
  return `<span class="rar ${cls}" title="${esc(r)}">${esc(s)}</span>`;
}
const num = (n) => n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** The card's own selling price (from an imported listing or typed in), else null. */
const ownPrice = (it) => { const v = parseFloat(String(it?.price ?? "").replace(",", ".")); return Number.isFinite(v) && v > 0 ? v : null; };
/** Price shown and counted for a card: its own selling price first, else the Cardmarket trend. */
const itemPrice = (it) => { const o = ownPrice(it); if (o != null) return { lo: o, hi: o, own: true }; const p = cmPrice(it.cm); return p ? { ...p, own: false } : null; };
const priceHtml = (it) => {
  const p = itemPrice(it);
  if (!p) return `<span class="price range">—</span>`;
  if (p.own) {
    // arrow: green ↑ when the market trend is above your price (you could ask more), red ↓ when below
    const m = cmPrice(it.cm), cote = m && m.lo === m.hi ? m.lo : null;
    let arrow = "";
    if (cote != null && Math.abs(cote - p.lo) >= 0.01) {
      const up = cote > p.lo, pct = Math.round(((cote - p.lo) / p.lo) * 100);
      arrow = `<span class="trend ${up ? "up" : "down"}" title="Cote Cardmarket ${eur(cote)} (${pct > 0 ? "+" : ""}${pct} % par rapport à ton prix)" aria-label="${up ? "Cote au-dessus de ton prix" : "Cote en dessous de ton prix"}">${ico(up ? "up" : "down")}</span>`;
    }
    return `<span class="price own" title="Ton prix de vente">${arrow}${esc(eur(p.lo))}</span>`;
  }
  return p.lo === p.hi ? `<span class="price" title="Cote tendance Cardmarket">${esc(eur(p.lo))}</span>` : `<span class="price range" title="Plusieurs versions possibles">${num(p.lo)}–${num(p.hi)} €</span>`;
};
/** Line in the detail panel: Cardmarket trend next to the own price. */
function marketLine(it) {
  const p = cmPrice(it.cm);
  if (!p) return "";
  const t = p.lo === p.hi ? eur(p.lo) : `${num(p.lo)}–${num(p.hi)} €`;
  const o = ownPrice(it);
  let diff = "";
  if (o != null && p.lo === p.hi && Math.abs(p.lo - o) >= 0.01) {
    const pct = Math.round(((p.lo - o) / o) * 100);
    diff = ` <span class="diff ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲ +" : "▼ "}${pct} %</span>`;
  }
  return `<p class="full muted small market-line">Cote Cardmarket (tendance) : <strong>${esc(t)}</strong>${o != null ? ` · ton prix : <strong>${esc(eur(o))}</strong>${diff}` : ""}</p>`;
}
const ico = (id) => `<svg class="ico"><use href="#i-${id}"/></svg>`;
/** YGOPRODeck id of the item's card (its thumbnail is img/<id>.webp). */
function cardImgId(it) {
  if (!DATA) return 0;
  const c = DATA.cards[it.card];
  if (c && c[0] === it.nameEN && c[2]) return c[2];
  const list = DATA.prints[it.key] || [];
  const e = list.find((x) => DATA.cards[x[0]][0] === it.nameEN) || list[0];
  return e ? DATA.cards[e[0]][2] || 0 : 0;
}
/** First photo taken of this card line, if it is on this phone. */
const itemPhoto = (it) => { if (!it.photos?.length || !photoCache) return null; for (const id of it.photos) { const p = photoCache.find((x) => x.id === id); if (p) return p; } return null; };
const thumb = (it, big = false) => {
  const ph = itemPhoto(it);
  if (ph) return `<span class="thumb ${big ? "lg" : ""} has-photo"><img src="${blobUrl(ph)}" alt="">${rarBadge(it.rarity)}<span class="cam-badge">${ico("camera")}${it.photos.length > 1 ? it.photos.length : ""}</span></span>`;
  const id = cardImgId(it);
  return `<span class="thumb ${big ? "lg" : ""}">${id ? `<img src="img/${id}.webp" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ""}${rarBadge(it.rarity)}</span>`;
};

function renderLast() {
  const box = $("last");
  const it = lastAdded && items.find((x) => x.id === lastAdded.id);
  if (!it) { box.hidden = true; return; }
  const fresh = box.dataset.id !== it.id + ":" + it.qty;
  box.dataset.id = it.id + ":" + it.qty;
  box.hidden = false; box.className = "last" + (it.rarity ? "" : " todo") + (fresh ? " enter" : "");
  box.innerHTML = `
    <div class="last-top">
      ${thumb(it, true)}
      <div class="last-main">
        <span class="eyebrow">Dernière carte${it.qty > 1 ? ` · ×${it.qty}` : ""}</span>
        <span class="name">${esc(it.nameFR)}</span>
        <span class="meta"><span class="code">${esc(it.code)}</span> · ${esc(it.set)}</span>
        ${(() => { const s = stockOf(it); return s ? `<span class="stock-pill">${ico("stack")} Déjà ${s.n} en stock${s.lang && s.lang !== s.n ? ` (${s.lang} ${LANG_SHORT[it.lang] || ""})` : ""}</span>` : ""; })()}
      </div>
      ${priceHtml(it)}
    </div>
    ${it.cands.length > 1 ? `${it.rarity ? "" : `<span class="ask">Quelle rareté ?</span>`}
      <div class="chips">${it.cands.map((c) => `<button class="chip ${c.rarity === it.rarity ? "on" : ""}" data-rar="${esc(c.rarity)}">${esc(c.rarity)}</button>`).join("")}</div>` : ""}
    <div class="actions">
      <button class="chip ${it.firstEd ? "on" : ""}" data-act="ed" aria-pressed="${it.firstEd}">1re édition</button>
      <button class="chip" data-act="plus">${ico("plus")} 1</button>
      <button class="chip" data-act="undo">${ico("undo")} Annuler</button>
      ${marketLinks(it)}
    </div>`;
}
$("last").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const it = lastAdded && items.find((x) => x.id === lastAdded.id); if (!it) return;
  if (b.dataset.rar) setRarity(it, b.dataset.rar);
  else if (b.dataset.act === "ed") it.firstEd = !it.firstEd;
  else if (b.dataset.act === "plus") { it.qty += 1; lastAdded.merged = true; }
  else if (b.dataset.act === "undo") return undoLast();
  saveItems(); renderLast();
});

let filter = "all", sortBy = "recent", query = "", openId = null;
let listMode = "session", selecting = false; const selected = new Set();
const PAGE = 150; let showMax = PAGE; // long lists are drawn 150 lines at a time
const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/g, "");
const unitPrice = (it) => { const p = itemPrice(it); return p ? (p.lo + p.hi) / 2 : -1; };
const rarClass = (r) => (RAR[r] || [null, "r-c"])[1];

/* ----- my Cardmarket stock (imported CSV, kept on this device) ----- */
let STOCK = store.get("cs-stock", null);
const stockKey = (setCode, cn, rarity) => `${String(setCode).toUpperCase().replace(/-[A-Z]$/, "")}-${cn}|${rarity}`;
function stockOf(it) {
  if (!STOCK) return null;
  const e = (typeof it.cm === "number" && it.cm && STOCK.byId[it.cm]) || (it.rarity && STOCK.byKey[stockKey(it.prefix, it.cn, it.rarity)]);
  return e ? { n: e.n, lang: e.lang[it.lang] || 0 } : null;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === "," || c === ";") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}
function importStock(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = (rows.shift() || []).map((h) => h.trim());
  const col = (n) => head.indexOf(n);
  const ci = { id: col("cardmarketId"), qty: col("quantity"), set: col("setCode"), cn: col("cn"), lang: col("language"), rar: col("rarity") };
  if (ci.id < 0 || ci.qty < 0) throw new Error("format");
  const byId = {}, byKey = {}; let n = 0;
  const add = (map, k, qty, lang) => { const e = map[k] || (map[k] = { n: 0, lang: {} }); e.n += qty; e.lang[lang] = (e.lang[lang] || 0) + qty; };
  for (const r of rows) {
    const qty = parseInt(r[ci.qty], 10) || 0; if (!qty) continue;
    const lang = r[ci.lang] || "";
    if (r[ci.id]) add(byId, r[ci.id], qty, lang);
    if (ci.set >= 0 && ci.cn >= 0 && ci.rar >= 0 && r[ci.set]) add(byKey, stockKey(r[ci.set], r[ci.cn], r[ci.rar]), qty, lang);
    n += qty;
  }
  STOCK = { at: Date.now(), lines: rows.length, cards: n, byId, byKey };
  if (!store.set("cs-stock", STOCK)) throw new Error("storage");
}
function renderStockInfo() {
  $("stockClear").hidden = !STOCK;
  $("stockLabel").firstChild.textContent = STOCK ? "Importer un export plus récent" : "Importer mon export (CSV)";
  $("stockInfo").textContent = STOCK
    ? `${STOCK.cards.toLocaleString("fr-FR")} cartes en stock (${STOCK.lines.toLocaleString("fr-FR")} lignes), importé le ${new Date(STOCK.at).toLocaleDateString("fr-FR")}.`
    : "Importe l'export de ton stock pour voir, sur chaque carte scannée, combien tu en as déjà en vente.";
}
$("stockFile").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try { importStock(await f.text()); renderStockInfo(); renderList(); renderLast(); toast(`Stock importé : ${STOCK.cards.toLocaleString("fr-FR")} cartes`); }
  catch (err) { toast(err.message === "format" ? "Ce fichier n'est pas un export de stock Cardmarket (colonne cardmarketId absente)." : "Import impossible : fichier trop gros pour cet appareil."); }
});
$("stockClear").addEventListener("click", () => { STOCK = null; try { localStorage.removeItem("cs-stock"); } catch {} renderStockInfo(); renderList(); renderLast(); toast("Stock retiré"); });
const stockTag = (it) => { const s = stockOf(it); return s ? `<span class="tag stock" title="Déjà dans ton stock Cardmarket">stock ${s.n}</span>` : ""; };

/* ----- "Ma collection": every session merged, one line per card version and language ----- */
const colKey = (it) => [typeof it.cm === "number" && it.cm ? it.cm : it.key, it.rarity, it.lang, it.firstEd].join("|");
function collection() {
  const map = new Map();
  for (const s of sessions) for (const it of s.items) {
    const k = colKey(it);
    let e = map.get(k);
    if (!e) { e = { ...it, id: "col:" + k, qty: 0, createdAt: 0, sessionsIn: [] }; map.set(k, e); }
    e.qty += it.qty; e.createdAt = Math.max(e.createdAt, it.createdAt || 0);
    const si = e.sessionsIn.find((x) => x.s === s); if (si) si.qty += it.qty; else e.sessionsIn.push({ s, qty: it.qty });
  }
  return [...map.values()];
}
const listSource = () => (listMode === "collection" ? collection() : items);

function visibleItems(list) {
  const q = fold(query);
  let out = list.filter((it) => {
    if (q && !fold(`${it.nameFR} ${it.nameEN} ${it.code} ${it.set}`).includes(q)) return false;
    if (filter === "todo") return !it.rarity;
    if (filter === "gem") return !!gemPrice(it);
    if (filter === "instock") return !!stockOf(it);
    if (filter === "photo") return !!it.photos?.length;
    if (filter === "notstock") return !stockOf(it);
    if (filter.startsWith("rar:")) return it.rarity && rarClass(it.rarity) === filter.slice(4);
    if (filter.startsWith("lang:")) return it.lang === filter.slice(5);
    return true;
  });
  const by = {
    recent: listMode === "collection" ? (a, b) => b.createdAt - a.createdAt : null,
    priceDesc: (a, b) => unitPrice(b) - unitPrice(a),
    priceAsc: (a, b) => (unitPrice(a) < 0) - (unitPrice(b) < 0) || unitPrice(a) - unitPrice(b),
    name: (a, b) => a.nameFR.localeCompare(b.nameFR, "fr"),
    set: (a, b) => a.set.localeCompare(b.set, "fr") || a.code.localeCompare(b.code),
  }[sortBy];
  if (by) out = [...out].sort(by);
  return out;
}
function renderList() {
  const curTotal0 = items.reduce((n, x) => n + x.qty, 0);
  $("tabCount").textContent = curTotal0; $("tabCount").classList.toggle("zero", !curTotal0);
  const hist = listMode === "history";
  $("view-list").classList.toggle("hist", hist); $("history").hidden = !hist;
  if (hist) { selecting = false; renderBulkBar(); renderHistory(); return; }
  const coll = listMode === "collection";
  const src = listSource();
  const total = src.reduce((n, x) => n + x.qty, 0);
  let value = 0, priced = 0;
  for (const x of src) { const p = itemPrice(x); if (p && p.lo === p.hi) { value += p.lo * x.qty; priced += x.qty; } }
  const ownN = src.reduce((n, x) => n + (ownPrice(x) != null ? x.qty : 0), 0);
  const todo = src.filter((x) => !x.rarity).length;
  const curTotal = items.reduce((n, x) => n + x.qty, 0);
  $("tabCount").textContent = curTotal; $("tabCount").classList.toggle("zero", !curTotal);
  $("sessionTitle").closest(".title-box").hidden = coll; $("collTitle").hidden = !coll;
  $("selectBtn").querySelector("span").textContent = selecting ? "Terminer" : "Sélectionner";
  if (!coll && document.activeElement !== $("sessionTitle")) $("sessionTitle").value = current.name;
  $("sessionDates").hidden = coll;
  if (!coll) {
    const fmt = (t, o) => new Date(t).toLocaleString("fr-FR", o);
    const lastScan = items.reduce((m, x) => Math.max(m, x.createdAt || 0), 0);
    $("sessionDates").textContent = `Commencée le ${fmt(current.createdAt, { weekday: "long", day: "numeric", month: "long" })} à ${fmt(current.createdAt, { hour: "2-digit", minute: "2-digit" })}`
      + (lastScan ? ` · dernier ajout le ${fmt(lastScan, { day: "numeric", month: "short" })} à ${fmt(lastScan, { hour: "2-digit", minute: "2-digit" })}` : "");
  }
  $("wipeBtn").hidden = !src.length;
  $("wipeBtn").querySelector("span").textContent = wipeArmed ? (coll ? "Confirmer : tout supprimer ?" : "Confirmer : vider la session ?") : (coll ? `Tout supprimer (${total} carte${total > 1 ? "s" : ""}, toutes sessions)` : "Vider cette session");
  $("statCards").textContent = total;
  $("statValue").textContent = priced ? eur(value).replace(/\s?€/, " €") : "—";
  $("statValueL").textContent = (ownN && ownN >= total * 0.5 ? "valeur (tes prix)" : "cote estimée") + (priced && priced < total ? ` ${priced}/${total}` : "");
  $("statTodo").textContent = todo; $("statTodoBox").classList.toggle("has", todo > 0);
  $("exportNote").hidden = !todo;
  $("exportNote").textContent = `${todo} carte${todo > 1 ? "s" : ""} sans rareté : choisis-la pour qu'elle${todo > 1 ? "s soient exportées" : " soit exportée"}.`;
  const shown = visibleItems(src);
  $("listCount").hidden = shown.length === src.length || !src.length;
  $("listCount").textContent = shown.length ? `${shown.length} ligne${shown.length > 1 ? "s" : ""} sur ${src.length} affichée${shown.length > 1 ? "s" : ""}` : "Aucune carte ne correspond.";
  $("empty").hidden = src.length > 0;
  $("empty").querySelector("p").textContent = coll ? "Ta collection est vide." : "Aucune carte dans cette session.";
  $("view-list").classList.toggle("selecting", selecting);
  renderInsights(src, coll);
  renderBulkBar();
  $("moreBtn").hidden = shown.length <= showMax;
  $("moreBtn").textContent = `Afficher ${Math.min(PAGE, shown.length - showMax)} de plus (${shown.length - showMax} restantes)`;
  $("list").innerHTML = shown.slice(0, showMax).map((it) => {
    const isNew = !coll && Date.now() - it.createdAt < 1500, open = openId === it.id && !selecting, sel = selected.has(it.id);
    return `<div class="item ${it.rarity ? "" : "todo"} ${isNew ? "enter" : ""} ${sel ? "selected" : ""}" data-id="${esc(it.id)}">
      <button class="row-main" data-act="${selecting ? "pick" : "toggle"}" aria-expanded="${open}" ${selecting ? `aria-pressed="${sel}"` : ""}>
        ${selecting ? `<span class="pick" aria-hidden="true">${sel ? ico("check") : ""}</span>` : ""}
        ${thumb(it)}
        <span class="row-text">
          <span class="name">${esc(it.nameFR)}</span>
          <span class="meta"><span class="code">${esc(it.code)}</span> · ${esc(it.set)}</span>
        </span>
        <span class="row-side">
          ${priceHtml(it)}
          <span class="tags">${gemPrice(it) ? `<span class="tag gem" title="Pépite">${ico("gem")}</span>` : ""}${stockTag(it)}${it.qty > 1 ? `<span class="tag qty">×${it.qty}</span>` : ""}${it.firstEd ? `<span class="tag ed">1re</span>` : ""}<span class="tag">${LANG_SHORT[it.lang] || ""}</span>${coll ? "" : `<span class="tag">${esc(it.condition)}</span>`}</span>
        </span>
      </button>
      ${open ? (coll ? collDetail(it) : editPanel(it)) : ""}
    </div>`;
  }).join("");
}
function editPanel(it) {
  return `<div class="edit">
    ${it.cands.length > 1 ? `<label class="full">Rareté<select data-f="rarity">${it.rarity ? "" : `<option value="">À choisir…</option>`}${it.cands.map((c) => `<option ${c.rarity === it.rarity ? "selected" : ""}>${esc(c.rarity)}</option>`).join("")}</select></label>` : ""}
    <label>État<select data-f="condition">${COND.map((c) => `<option ${c === it.condition ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <label>Langue<select data-f="lang">${LANGS.map((l) => `<option value="${l}" ${l === it.lang ? "selected" : ""}>${LANG_SHORT[l]}</option>`).join("")}</select></label>
    <label>Prix de vente<input data-f="price" inputmode="decimal" placeholder="€" value="${esc(it.price)}"></label>
    <label>Commentaire<input data-f="comment" placeholder="—" value="${esc(it.comment)}"></label>
    ${stockLine(it)}
    ${photoStrip(it)}
    ${marketLine(it)}
    <p class="full muted small scanned">Scannée le ${new Date(it.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })} à ${new Date(it.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
    <div class="edit-row full">
      <span class="qty"><button data-act="minus" aria-label="Retirer un exemplaire">${ico("minus")}</button><span>${it.qty}</span><button data-act="plus" aria-label="Ajouter un exemplaire">${ico("plus")}</button></span>
      <button class="chip ${it.firstEd ? "on" : ""}" data-act="ed" aria-pressed="${it.firstEd}">1re édition</button>
      ${marketLinks(it)}
      <button class="del" data-act="del" aria-label="Supprimer">${ico("trash")}</button>
    </div>
  </div>`;
}
function photoStrip(it) {
  const ps = (it.photos || []).map((id) => photoCache?.find((p) => p.id === id)).filter(Boolean);
  return ps.length ? `<div class="full photo-strip">${ps.map((p) => `<button type="button" class="ps" data-act="photo" data-photo="${p.id}"><img src="${blobUrl(p)}" alt="Photo"></button>`).join("")}</div>` : "";
}
function stockLine(it) {
  const s = stockOf(it);
  return s ? `<p class="stock-line full">${ico("stack")} Déjà <strong>${s.n}</strong> dans ton stock Cardmarket${s.lang && s.lang !== s.n ? `, dont ${s.lang} en ${LANG_SHORT[it.lang] || ""}` : ""}.</p>` : "";
}
function collDetail(it) {
  return `<div class="edit coll">
    ${stockLine(it)}
    <p class="full muted small">Présente dans ${it.sessionsIn.length} session${it.sessionsIn.length > 1 ? "s" : ""} :</p>
    ${it.sessionsIn.map(({ s, qty }) => `<button class="sess-link full" data-act="opensession" data-sid="${s.id}"><span>${esc(s.name)}</span><span class="tag qty">×${qty}</span>${ico("chev")}</button>`).join("")}
    <div class="edit-row">${marketLinks(it)}</div>
  </div>`;
}
const itemOf = (el) => items.find((x) => x.id === el.closest("[data-id]")?.dataset.id);
$("list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const a = b.dataset.act, rowId = b.closest("[data-id]")?.dataset.id;
  if (a === "toggle") { openId = openId === rowId ? null : rowId; renderList(); return; }
  if (a === "pick") { selected.has(rowId) ? selected.delete(rowId) : selected.add(rowId); renderList(); return; }
  if (a === "photo") { openViewer(photoCache.findIndex((p) => p.id === b.dataset.photo)); return; }
  if (a === "opensession") { const s = sessions.find((x) => x.id === b.dataset.sid); if (s) { switchSession(s); setListMode("session"); toast(`Session « ${s.name} » ouverte`); } return; }
  const it = itemOf(b); if (!it) return;
  if (a === "plus") it.qty += 1;
  else if (a === "minus") { if (it.qty <= 1) return; it.qty -= 1; }
  else if (a === "ed") it.firstEd = !it.firstEd;
  else if (a === "del") { items = items.filter((x) => x !== it); openId = null; toast(`${it.nameFR} retirée`); }
  saveItems(); renderLast();
});
$("list").addEventListener("change", (e) => {
  const f = e.target.dataset.f; const it = itemOf(e.target); if (!f || !it) return;
  if (f === "rarity") setRarity(it, e.target.value);
  else if (f === "price") it.price = e.target.value.trim().replace(",", ".");
  else it[f] = e.target.value.trim();
  saveItems(); renderLast();
});
let searchT;
$("listSearch").addEventListener("input", (e) => { clearTimeout(searchT); searchT = setTimeout(() => { query = e.target.value; showMax = PAGE; renderList(); }, 120); });
$("listSort").addEventListener("change", (e) => { sortBy = e.target.value; showMax = PAGE; renderList(); });
$("listFilter").addEventListener("change", (e) => { filter = e.target.value; showMax = PAGE; renderList(); });
$("moreBtn").addEventListener("click", () => { showMax += PAGE; renderList(); });
$("statTodoBox").addEventListener("click", () => { filter = filter === "todo" ? "all" : "todo"; $("listFilter").value = filter; renderList(); });
function setListMode(m) {
  listMode = m; openId = null; selecting = false; selected.clear(); showMax = PAGE;
  $("listMode").querySelectorAll(".seg").forEach((s) => s.classList.toggle("on", s.dataset.mode === m));
  renderList(); window.scrollTo(0, 0);
}
$("listMode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setListMode(b.dataset.mode); });

/* ----- grouped actions ----- */
$("selectBtn").addEventListener("click", () => { selecting = !selecting; selected.clear(); openId = null; renderList(); });
/** Remove matching cards from every session (used from "Ma collection"). */
function removeFromAllSessions(match) {
  for (const s of sessions) {
    const kept = s.items.filter((it) => !match(it));
    if (kept.length !== s.items.length) { s.items = kept; s.updatedAt = Date.now(); }
  }
  items = current.items;
  if (lastAdded && !items.some((x) => x.id === lastAdded.id)) lastAdded = null;
}
/* ----- "Vider cette session" / "Tout supprimer" ----- */
let wipeArmed = 0;
$("wipeBtn").addEventListener("click", () => {
  const coll = listMode === "collection";
  if (Date.now() - wipeArmed > 4000) { wipeArmed = Date.now(); renderList(); setTimeout(() => { if (wipeArmed && Date.now() - wipeArmed >= 4000) { wipeArmed = 0; renderList(); } }, 4100); return; }
  wipeArmed = 0;
  if (coll) {
    const n = sessions.length;
    const dead = store.get("cs-deleted", []); for (const s of sessions) dead.push({ id: s.id, at: Date.now() }); store.set("cs-deleted", dead);
    sessions = [newSession()]; switchSession(sessions[0]);
    toast(`Tout supprimé (${n} session${n > 1 ? "s" : ""})`);
  } else {
    items = []; lastAdded = null; saveItems(); renderLast(); toast("Session vidée");
  }
});
$("renameBtn").addEventListener("click", () => { const i = $("sessionTitle"); i.focus(); i.select(); });
$("sessionTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });

/* ----- Historique: every session, newest first, grouped by day ----- */
let histRename = null, histDel = null;
function dayLabel(t) {
  const d = new Date(t), today = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(today) - day(d)) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
function renderHistory() {
  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  let html = `<div class="hist-actions"><button class="btn primary" data-h="new">${ico("plus")} Nouvelle session</button><label class="btn" title="Importer un export de stock Cardmarket ou PowerTools">${ico("share")} Importer un CSV<input type="file" id="importCsv" accept=".csv,text/csv" hidden></label></div>`, lastDay = "";
  for (const s of sorted) {
    const day = dayLabel(s.createdAt);
    if (day !== lastDay) { html += `<h3 class="hday">${esc(day.charAt(0).toUpperCase() + day.slice(1))}</h3>`; lastDay = day; }
    const { n, v } = sessionStats(s), cur = s === current;
    const start = new Date(s.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const lastScan = s.items.reduce((m, x) => Math.max(m, x.createdAt || 0), 0);
    const end = lastScan && lastScan - s.createdAt > 60000 ? ` → ${new Date(lastScan).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "";
    const thumbs = [...s.items].sort((a, b) => unitPrice(b) - unitPrice(a)).slice(0, 3).map((it) => thumb(it)).join("");
    html += `<div class="hrow ${cur ? "on" : ""}" data-sid="${s.id}">
      ${histRename === s.id
        ? `<form class="hrename" data-h="renameform"><input value="${esc(s.name)}" maxlength="60" aria-label="Nouveau nom"><button class="btn primary small" type="submit">OK</button></form>`
        : `<button class="hopen" data-h="open">
            <span class="hthumbs">${thumbs || `<span class="thumb"></span>`}</span>
            <span class="row-text"><span class="name">${esc(s.name)}</span>
              <span class="meta">${ico("clock")} ${start}${end} · ${n} carte${n > 1 ? "s" : ""}${v ? ` · ≈ ${esc(eur(v))}` : ""}</span></span>
            ${cur ? `<span class="tag qty">en cours</span>` : ""}
          </button>
          <div class="hacts">
            <button class="icon-btn sm" data-h="rename" aria-label="Renommer">${ico("pencil")}</button>
            <button class="icon-btn sm del-ico" data-h="del" aria-label="Supprimer">${histDel === s.id ? "OK ?" : ico("trash")}</button>
          </div>`}
    </div>`;
  }
  $("history").innerHTML = html;
  const inp = $("history").querySelector(".hrename input"); if (inp) { inp.focus(); inp.select(); }
}
$("history").addEventListener("click", (e) => {
  const b = e.target.closest("[data-h]"); if (!b || b.tagName === "FORM") return;
  if (b.dataset.h === "new") { startNewSession(); if (!items.length) setListMode("session"); return; }
  const s = sessions.find((x) => x.id === b.closest("[data-sid]")?.dataset.sid); if (!s) return;
  if (b.dataset.h === "open") { switchSession(s); setListMode("session"); return; }
  if (b.dataset.h === "rename") { histRename = s.id; histDel = null; renderHistory(); return; }
  if (b.dataset.h === "del") {
    if (histDel !== s.id) { histDel = s.id; renderHistory(); setTimeout(() => { if (histDel === s.id) { histDel = null; renderHistory(); } }, 4000); return; }
    histDel = null; deleteSession(s); renderHistory(); toast("Session supprimée");
  }
});
$("history").addEventListener("submit", (e) => {
  e.preventDefault();
  const s = sessions.find((x) => x.id === e.target.closest("[data-sid]")?.dataset.sid);
  const v = e.target.querySelector("input").value.trim();
  histRename = null;
  if (s && v) { s.name = v; s.updatedAt = Date.now(); saveItems(); toast("Session renommée"); }
  renderHistory();
});
function renderBulkBar() {
  const on = selecting && listMode !== "history";
  $("bulkBar").hidden = !on; document.body.classList.toggle("bulk-on", on);
  if (!on) return;
  const n = selected.size, coll = listMode === "collection";
  $("bulkCount").textContent = `${n} sélectionnée${n > 1 ? "s" : ""}`;
  $("bulkBar").querySelectorAll(".bulk-actions button").forEach((b) => { b.disabled = !n; b.hidden = coll && b.dataset.bulk !== "del"; });
  $("bulkBar").querySelector('[data-bulk="all"]').textContent = n && n === visibleItems(listSource()).length ? "Aucune" : "Tout";
}
const picked = () => items.filter((x) => selected.has(x.id));
function openBulk(title, html) { $("bulkTitle").textContent = title; $("bulkBody").innerHTML = html; $("bulkSheet").hidden = false; }
const closeBulk = () => ($("bulkSheet").hidden = true);
function endBulk(msg) { closeBulk(); selected.clear(); saveItems(); renderLast(); if (msg) toast(msg); }
let bulkDelArmed = 0;
$("bulkBar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bulk]"); if (!b) return;
  const n = selected.size, act = b.dataset.bulk;
  if (act === "done") { selecting = false; selected.clear(); renderList(); return; }
  if (act === "all") { const vis = visibleItems(listSource()); if (n && n === vis.length) selected.clear(); else vis.forEach((x) => selected.add(x.id)); renderList(); return; }
  if (!n) return;
  if (act === "cond") openBulk(`État de ${n} carte${n > 1 ? "s" : ""}`, `<div class="chips big">${COND.map((c) => `<button class="chip" data-set-cond="${c}">${c}</button>`).join("")}</div>`);
  if (act === "comment") openBulk(`Commentaire de ${n} carte${n > 1 ? "s" : ""}`, `<form id="bulkCommentForm" class="acc-form"><input id="bulkComment" placeholder="ex. CM40-01 (vide pour effacer)"><button class="btn primary wide" type="submit">Appliquer</button></form>`);
  if (act === "move") openBulk(`Déplacer ${n} carte${n > 1 ? "s" : ""} vers…`, `<div class="slist">${sessions.filter((s) => s !== current).map((s) => `<button class="sess-link" data-move="${s.id}"><span>${esc(s.name)}</span><span class="muted small">${sessionStats(s).n} cartes</span>${ico("chev")}</button>`).join("")}<button class="btn primary wide" data-move="new">${ico("plus")} Nouvelle session</button></div>`);
  if (act === "del") {
    if (Date.now() - bulkDelArmed > 4000) { bulkDelArmed = Date.now(); b.querySelector("span").textContent = "Confirmer ?"; setTimeout(() => (b.querySelector("span").textContent = "Supprimer"), 4000); return; }
    bulkDelArmed = 0; b.querySelector("span").textContent = "Supprimer";
    if (listMode === "collection") removeFromAllSessions((it) => selected.has("col:" + colKey(it)));
    else items = items.filter((x) => !selected.has(x.id));
    endBulk(`${n} ligne${n > 1 ? "s" : ""} supprimée${n > 1 ? "s" : ""}`);
  }
});
$("bulkClose").addEventListener("click", closeBulk);
$("bulkSheet").addEventListener("click", (e) => {
  if (e.target === $("bulkSheet")) return closeBulk();
  const c = e.target.closest("[data-set-cond]");
  if (c) { picked().forEach((it) => (it.condition = c.dataset.setCond)); return endBulk(`État ${c.dataset.setCond} appliqué`); }
  const m = e.target.closest("[data-move]");
  if (m) {
    let target = sessions.find((s) => s.id === m.dataset.move);
    if (m.dataset.move === "new") { target = newSession(); sessions.unshift(target); }
    if (!target) return;
    const moving = picked();
    for (const it of moving) {
      const twin = target.items.find((x) => mergeKey(x) === mergeKey(it));
      if (twin) twin.qty += it.qty; else target.items.unshift(it);
    }
    target.updatedAt = Date.now();
    items = items.filter((x) => !selected.has(x.id));
    if (lastAdded && selected.has(lastAdded.id)) lastAdded = null;
    endBulk(`${moving.length} carte${moving.length > 1 ? "s" : ""} déplacée${moving.length > 1 ? "s" : ""} vers « ${target.name} »`);
  }
});
$("bulkSheet").addEventListener("submit", (e) => {
  if (e.target.id !== "bulkCommentForm") return;
  e.preventDefault();
  const v = $("bulkComment").value.trim();
  picked().forEach((it) => (it.comment = v));
  endBulk(v ? "Commentaire appliqué" : "Commentaires effacés");
});

/* ----- import a Cardmarket / PowerTools stock export as a new session ----- */
const cleanCmName = (n) => String(n || "").replace(/\s*\(V\.\d+[^)]*\)\s*$/, "").replace(/^"+|"+$/g, "").trim();
function itemFromCsv(r) {
  const setCode = String(r.setCode || "").toUpperCase().replace(/-[A-Z]$/, ""), cn = String(r.cn || "").trim();
  const key = `${setCode}-${cn}`;
  const lang = LANGS.includes(r.language) ? r.language : settings.lang;
  const cmId = parseInt(r.cardmarketId, 10) || 0;
  const it = {
    id: uid(), createdAt: Date.parse(r.listedAt) || Date.now(), key, code: `${setCode}-${REGION_OF[lang] || "EN"}${cn}`, prefix: setCode, cn,
    lang, firstEd: String(r.isFirstEd).toLowerCase() === "true", condition: COND.includes(r.condition) ? r.condition : "NM",
    comment: r.comment || "", qty: parseInt(r.quantity, 10) || 1, price: String(r.price || "").replace(",", "."), cands: [],
  };
  const cands = DATA?.prints[key] ? candidatesFor(key) : [];
  const c = cands.find((x) => (Array.isArray(x.cm) ? x.cm.includes(cmId) : x.cm === cmId) && cmId)
    || cands.find((x) => x.rarity === r.rarity) || (cands.length === 1 ? cands[0] : null);
  if (c) {
    applyCandidate(it, c);
    // the card database lacks some French names: the export has them
    if (cleanCmName(r.nameFR) && it.nameFR === it.nameEN) it.nameFR = cleanCmName(r.nameFR);
  } else { it.card = -1; it.nameEN = cleanCmName(r.name); it.nameFR = cleanCmName(r.nameFR) || it.nameEN; it.set = r.set || setCode; }
  it.rarity = r.rarity || it.rarity || "";
  if (cmId) it.cm = cmId; // the export knows the exact Cardmarket product
  return it;
}
function importListings(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const head = (rows.shift() || []).map((h) => h.trim());
  if (!head.includes("cardmarketId") || !head.includes("quantity")) throw new Error("format");
  const its = rows.map((r) => itemFromCsv(Object.fromEntries(head.map((h, i) => [h, r[i]])))).filter((it) => it.qty > 0);
  if (!its.length) throw new Error("empty");
  const d = new Date();
  const s = { ...newSession(its), name: `Import Cardmarket · ${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` };
  sessions.unshift(s);
  return s;
}
$("history").addEventListener("change", async (e) => {
  if (e.target.id !== "importCsv") return;
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (!DATA) { toast("La base de cartes charge encore, réessaie dans un instant."); return; }
  try {
    toast("Import en cours…");
    const s = importListings(await f.text());
    switchSession(s); setListMode("session");
    const n = s.items.reduce((a, x) => a + x.qty, 0);
    toast(`${s.items.length.toLocaleString("fr-FR")} annonces importées (${n.toLocaleString("fr-FR")} cartes)`);
  } catch (err) {
    console.warn(err);
    toast(err.message === "format" ? "Ce fichier n'est pas un export de stock Cardmarket (colonnes cardmarketId et quantity absentes)."
      : err.message === "empty" ? "Aucune carte trouvée dans ce fichier." : "Import impossible : " + err.message);
  }
});

/* ----- top of the session (or of the collection) ----- */
function renderInsights(src = items, coll = false) {
  const box = $("insights");
  $("insightsTitle").textContent = coll ? "Top de la collection" : "Top de la session";
  const priced = src.map((it) => ({ it, p: itemPrice(it) })).filter((x) => x.p && x.p.lo === x.p.hi);
  box.hidden = priced.length < 2;
  if (box.hidden) return;
  const top = [...priced].sort((a, b) => b.p.lo - a.p.lo).slice(0, 10);
  const bySet = new Map();
  for (const { it, p } of priced) bySet.set(it.set, (bySet.get(it.set) || 0) + p.lo * it.qty);
  const sets = [...bySet.entries()].sort((a, b) => b[1] - a[1]);
  const shownSets = sets.slice(0, 8), rest = sets.slice(8).reduce((n, [, v]) => n + v, 0);
  const max = shownSets[0]?.[1] || 1;
  $("insightsBody").innerHTML = `
    <h3 class="ins-title">Les ${top.length} cartes les plus chères</h3>
    <ol class="top">${top.map(({ it, p }, i) => `
      <li><span class="rank">${i + 1}</span>${thumb(it)}
        <span class="row-text"><span class="name">${esc(it.nameFR)}</span><span class="meta"><span class="code">${esc(it.code)}</span>${it.qty > 1 ? ` · ×${it.qty}` : ""}</span></span>
        <span class="price">${esc(eur(p.lo))}</span></li>`).join("")}
    </ol>
    <h3 class="ins-title">Valeur par extension</h3>
    <div class="bars">${shownSets.map(([s, v]) => `
      <div class="bar"><div class="bar-head"><span class="bar-name">${esc(s)}</span><span class="bar-val">${esc(eur(v))}</span></div>
        <div class="bar-track"><span style="width:${Math.max(3, (v / max) * 100).toFixed(1)}%"></span></div></div>`).join("")}
      ${rest ? `<div class="bar muted small">+ ${sets.length - 8} autres extensions : ${esc(eur(rest))}</div>` : ""}
    </div>
    <p class="muted small">Calculé avec ton prix de vente quand il est renseigné, sinon la cote tendance Cardmarket de la version exacte.</p>`;
}

/* ================= sessions UI ================= */
function sessionStats(s) {
  let n = 0, v = 0; for (const x of s.items) { n += x.qty; const p = itemPrice(x); if (p && p.lo === p.hi) v += p.lo * x.qty; }
  return { n, v };
}
function renderSessionBar() {
  $("sessionName").textContent = current.name;
  const { n } = sessionStats(current);
  $("sessionCount").textContent = n;
}
function deleteSession(s) {
  const dead = store.get("cs-deleted", []); dead.push({ id: s.id, at: Date.now() }); store.set("cs-deleted", dead);
  sessions = sessions.filter((x) => x !== s);
  if (!sessions.length) sessions = [newSession()];
  if (s === current) switchSession(sessions[0]); else saveItems();
}
let delArmed = null;
function renderSessions() {
  $("sessionList").innerHTML = sessions.map((s) => {
    const { n, v } = sessionStats(s);
    const d = new Date(s.updatedAt || s.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
    return `<div class="srow ${s === current ? "on" : ""}" data-sid="${s.id}">
      <button class="sopen" data-act="open"><span class="name">${esc(s.name)}</span>
        <span class="meta">${n} carte${n > 1 ? "s" : ""}${v ? ` · ≈ ${eur(v)}` : ""} · ${d}${s === current ? " · en cours" : ""}</span></button>
      <button class="del" data-act="del" aria-label="Supprimer la session">${delArmed === s.id ? "Confirmer ?" : ico("trash")}</button>
    </div>`;
  }).join("");
}
function openSheet() { delArmed = null; renderSessions(); $("sheet").hidden = false; }
$("sessionBar").addEventListener("click", (e) => { if (!e.target.closest("#newSessionBtn")) openSheet(); });
$("newSessionBtn").addEventListener("click", startNewSession);
$("sheetNew").addEventListener("click", () => { startNewSession(); $("sheet").hidden = true; });
$("sheetClose").addEventListener("click", () => ($("sheet").hidden = true));
$("sheet").addEventListener("click", (e) => {
  if (e.target === $("sheet")) { $("sheet").hidden = true; return; }
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const s = sessions.find((x) => x.id === b.closest("[data-sid]").dataset.sid); if (!s) return;
  if (b.dataset.act === "open") { switchSession(s); $("sheet").hidden = true; toast(`Session « ${s.name} » ouverte`); return; }
  if (delArmed !== s.id) { delArmed = s.id; renderSessions(); setTimeout(() => { if (delArmed === s.id) { delArmed = null; renderSessions(); } }, 4000); return; }
  delArmed = null; deleteSession(s); renderSessions(); toast("Session supprimée");
});
$("sessionTitle").addEventListener("change", (e) => {
  const v = e.target.value.trim(); if (!v) { e.target.value = current.name; return; }
  current.name = v; saveItems();
});

/* ================= export ================= */
const HEAD = ["cardmarketId", "quantity", "name", "set", "setCode", "cn", "condition", "language", "isFirstEd", "isSigned", "price", "comment", "nameDE", "nameES", "nameFR", "nameIT", "rarity", "listedAt"];
const q = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
function buildCsv(list = listSource()) {
  const rows = new Map();
  for (const it of list) {
    if (!it.rarity) continue;
    const id = typeof it.cm === "number" ? it.cm : "";
    let price = it.price;
    if (!price && settings.priceTrend && id) price = DATA?.prices[id]?.[0] ?? "";
    const k = [id || it.key, it.rarity, it.lang, it.firstEd, it.condition, price, it.comment].join("|");
    const r = rows.get(k);
    if (r) r.qty += it.qty; else rows.set(k, { it, id, price, qty: it.qty });
  }
  const lines = [HEAD.map(q).join(",")];
  for (const { it, id, price, qty } of rows.values())
    lines.push([id, qty, it.nameEN, it.set, it.prefix, it.cn, it.condition, it.lang, it.firstEd ? "true" : "", "", price, it.comment, "", "", it.nameFR, "", it.rarity, ""].map(q).join(","));
  return { csv: lines.join("\r\n") + "\r\n", count: rows.size };
}
$("exportBtn").addEventListener("click", async () => {
  const { csv, count } = buildCsv();
  if (!count) { toast("Rien à exporter (choisis la rareté des cartes en orange)."); return; }
  const slug = (listMode === "collection" ? "ma collection" : current.name).normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const name = `cardmarket-${slug || "scan"}.csv`;
  const file = new File(["﻿" + csv], name, { type: "text/csv" });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
});

/* ================= settings & navigation ================= */
function bindSettings() {
  $("setCond").value = settings.cond; $("setLang").value = settings.lang; $("setComment").value = settings.comment;
  $("setPriceTrend").checked = settings.priceTrend; $("setSound").checked = settings.sound; $("setDebug").checked = settings.debug;
  $("setGem").value = settings.gem;
  const save = () => {
    const gem = Math.max(0, Number(String($("setGem").value).replace(",", ".")) || 0);
    Object.assign(settings, { cond: $("setCond").value, lang: $("setLang").value, comment: $("setComment").value.trim(), priceTrend: $("setPriceTrend").checked, sound: $("setSound").checked, debug: $("setDebug").checked, gem });
    store.set("cs-settings", settings);
    if (!settings.debug) $("debug").hidden = true;
    renderList();
  };
  ["setCond", "setLang", "setComment", "setPriceTrend", "setSound", "setDebug", "setGem"].forEach((id) => $(id).addEventListener("change", save));
}
let clearArmed = 0;
$("clearBtn").addEventListener("click", () => {
  const idle = `${ico("trash")} Supprimer cette session`;
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); $("clearBtn").innerHTML = `${ico("trash")} Confirmer la suppression ?`; setTimeout(() => ($("clearBtn").innerHTML = idle), 4000); return; }
  clearArmed = 0; deleteSession(current); $("clearBtn").innerHTML = idle; toast("Session supprimée");
});
/* ----- pages: auth → home → scanner / lists / settings ----- */
const VIEWS = ["auth", "home", "scan", "list", "settings", "photos"];
let view = null;
function showView(v) {
  view = v;
  for (const n of VIEWS) $("view-" + n).hidden = v !== n;
  $("tabs").hidden = v === "auth";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === v));
  window.scrollTo(0, 0);
  if (v !== "scan" && (scanning || (camMode === "photo" && liveTrack()))) pauseScan();
  if (v === "photos") renderPhotos();
  if (v === "scan" && wantScan && !scanning) startCamera();
  if (v === "home") renderHome();
}
$("tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) showView(b.dataset.view); });
$("view-home").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) showView(b.dataset.go); });
function renderHome() {
  const md = user?.user_metadata || {};
  const name = (md.full_name || md.name || md.custom_claims?.global_name || "").split(" ")[0] || (user?.email ? user.email.split("@")[0] : "");
  $("homeHello").textContent = user ? `Bonjour ${name}` : "Mode sans compte";
  const { n } = sessionStats(current);
  $("homeScanSub").textContent = n ? `Continuer « ${current.name} » · ${n} carte${n > 1 ? "s" : ""}` : `Session « ${current.name} »`;
  $("homeListSub").textContent = `${sessions.length} session${sessions.length > 1 ? "s" : ""}`;
  let cards = 0, val = 0; for (const s of sessions) { const st = sessionStats(s); cards += st.n; val += st.v; }
  $("homeCards").textContent = cards;
  $("homeValue").textContent = val ? eur(val) : "—";
  updateHomeSync();
}
function updateHomeSync(state) {
  const pill = $("homeSync");
  pill.className = "sync-pill " + (user ? (state || (lastSync ? "ok" : "")) : "");
  $("homeSyncTxt").textContent = !user ? "Sans compte" : state === "busy" ? "Synchro…" : state === "err" ? "Synchro en échec" : "Synchronisé";
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (scanning || stream)) stopCamera(true); // app in the background: release the camera
  else if (!document.hidden && wantScan && !scanning && !$("view-scan").hidden) startCamera();
});
$("startBtn").addEventListener("click", () => {
  scanning ? stopCamera() : startCamera();
});

/* ================= photo mode: pictures of cards for listings ================= */
let camMode = settings.camMode === "photo" ? "photo" : "scan";
function renderCamMode() {
  $("camMode").querySelectorAll(".seg").forEach((b) => b.classList.toggle("on", b.dataset.cam === camMode));
  $("stage").classList.toggle("photo-mode", camMode === "photo");
  $("importPhotoBtn").hidden = camMode === "photo";
  $("galleryBtn").hidden = camMode !== "photo";
}
function enterPhotoMode() {
  setStatus(scanning ? "Mode photo : chaque carte reconnue est photographiée et ajoutée" : "Mode photo : appuie sur le bouton pour lancer le scan avec photos");
}
$("camMode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cam]"); if (!b || b.dataset.cam === camMode) return;
  camMode = b.dataset.cam; settings.camMode = camMode; store.set("cs-settings", settings);
  renderCamMode();
  if (camMode === "photo") enterPhotoMode();
  else setStatus(scanning ? "Place une carte dans le cadre" : "Appuie sur le bouton pour lancer la caméra");
});
let photoCache = null; // [{id, createdAt, thumb, blob, w, h, code, name, key}]
async function loadPhotos() {
  try { photoCache = (await idb.photos()).sort((a, b) => b.createdAt - a.createdAt); } catch (e) { console.warn(e); photoCache = []; }
  updatePhotoBadge(); renderList(); renderLast(); // card lines can now show their own photos
}
const objUrls = new Map();
const blobUrl = (p, which = "thumb") => { const k = p.id + which; if (!objUrls.has(k)) objUrls.set(k, URL.createObjectURL(p[which])); return objUrls.get(k); };
function dropUrls(id) { for (const w of ["thumb", "blob"]) { const k = id + w; if (objUrls.has(k)) { URL.revokeObjectURL(objUrls.get(k)); objUrls.delete(k); } } }
function updatePhotoBadge() {
  const n = photoCache?.length || 0;
  $("photoCount").textContent = n; $("photoCount").classList.toggle("zero", !n);
  const latest = photoCache?.[0];
  $("galleryThumb").hidden = !latest; $("galleryIco").style.display = latest ? "none" : ""; // (svg has no "hidden" property)
  if (latest) $("galleryThumb").src = blobUrl(latest);
  $("homePhotoSub").textContent = n ? `${n} photo${n > 1 ? "s" : ""}` : "Pour tes annonces";
}
const toBlob = (c, q = 0.92) => new Promise((res) => c.toBlob(res, "image/jpeg", q));
/** Picture of the card in the frame (small margin, full camera resolution), grabbed right now. */
function capturePhoto(r = guideInVideo()) {
  const m = 0.05;
  const x = Math.max(0, r.x - r.w * m), y = Math.max(0, r.y - r.h * m);
  const w = Math.min(video.videoWidth - x, r.w * (1 + 2 * m)), h = Math.min(video.videoHeight - y, r.h * (1 + 2 * m));
  const full = grab(video, x, y, w, h, 2400);
  // shutter flash, driven by timers so it never stays white
  const snap = $("snap"); snap.style.transition = "none"; snap.style.opacity = "0.85";
  setTimeout(() => { snap.style.transition = "opacity .3s ease-out"; snap.style.opacity = "0"; }, 60);
  setTimeout(() => { snap.style.transition = "none"; snap.style.opacity = "0"; }, 450);
  return full;
}
/** Store the picture and link it to the card line it was taken for. */
async function attachPhoto(full, it, itemId) {
  try {
    const thumbC = grab(full, 0, 0, full.width, full.height, 360);
    const p = { id: uid(), createdAt: Date.now(), w: full.width, h: full.height, blob: await toBlob(full, 0.92), thumb: await toBlob(thumbC, 0.8),
      code: it.code, name: it.nameFR || it.nameEN || "", key: it.key, itemId: itemId || "", sessionId: current.id };
    await idb.putPhoto(p);
    photoCache = [p, ...(photoCache || [])]; updatePhotoBadge(); bump($("galleryBtn"));
    const line = items.find((x) => x.id === itemId);
    if (line) { line.photos = [...(line.photos || []), p.id]; saveItems(); renderLast(); }
    if (view === "photos") renderPhotos();
  } catch (e) { console.warn(e); toast("Photo non enregistrée (mémoire du téléphone pleine ?)"); }
}
$("galleryBtn").addEventListener("click", () => showView("photos"));

/* ----- "Mes photos" ----- */
let photoSelecting = false; const photoSel = new Set(); let viewerIdx = -1;
async function renderPhotos() {
  if (!photoCache) await loadPhotos();
  const ps = photoCache;
  $("photoEmpty").hidden = ps.length > 0;
  $("photoInfo").textContent = ps.length ? `${ps.length} photo${ps.length > 1 ? "s" : ""} · enregistrées sur ce téléphone (non synchronisées). Touche une photo pour l'ouvrir, la partager ou l'enregistrer dans ta galerie.` : "";
  $("photoSelectBtn").hidden = !ps.length;
  $("photoSelectBtn").querySelector("span").textContent = photoSelecting ? "Terminer" : "Sélectionner";
  $("view-photos").classList.toggle("selecting", photoSelecting);
  $("photoActions").hidden = !photoSelecting;
  $("photoSelCount").textContent = `${photoSel.size} sélectionnée${photoSel.size > 1 ? "s" : ""}`;
  $("photoActions").querySelectorAll('[data-pa="share"],[data-pa="del"]').forEach((b) => (b.disabled = !photoSel.size));
  $("photoGrid").innerHTML = ps.map((p) => `
    <button class="ph ${photoSel.has(p.id) ? "selected" : ""}" data-pid="${p.id}" aria-label="${esc(p.name || p.code || "Photo")}">
      <img src="${blobUrl(p)}" alt="" loading="lazy">
      ${photoSelecting ? `<span class="pick">${photoSel.has(p.id) ? ico("check") : ""}</span>` : ""}
      ${p.code ? `<span class="ph-code">${esc(p.code)}</span>` : ""}
    </button>`).join("");
}
$("photoSelectBtn").addEventListener("click", () => { photoSelecting = !photoSelecting; photoSel.clear(); renderPhotos(); });
$("view-photos").addEventListener("click", (e) => {
  if (e.target.closest("[data-go-photo]")) { camMode = "photo"; settings.camMode = "photo"; store.set("cs-settings", settings); renderCamMode(); enterPhotoMode(); showView("scan"); return; }
  const t = e.target.closest("[data-pid]"); if (!t) return;
  const id = t.dataset.pid;
  if (photoSelecting) { photoSel.has(id) ? photoSel.delete(id) : photoSel.add(id); renderPhotos(); return; }
  openViewer(photoCache.findIndex((p) => p.id === id));
});
const photoFile = (p, i = 0) => new File([p.blob], `${(p.code || "carte").replace(/[^\w-]+/g, "")}${p.name ? "-" + p.name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\w]+/g, "-").slice(0, 40) : ""}${i ? "-" + i : ""}.jpg`, { type: "image/jpeg" });
async function sharePhotos(list) {
  const files = list.map((p, i) => photoFile(p, list.length > 1 ? i + 1 : 0));
  try {
    if (navigator.canShare?.({ files })) { await navigator.share({ files }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  for (const f of files) { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }
}
async function deletePhotos(ids) {
  for (const id of ids) { try { await idb.delPhoto(id); } catch {} dropUrls(id); }
  photoCache = photoCache.filter((p) => !ids.includes(p.id)); updatePhotoBadge();
}
let photoDelArmed = 0;
$("photoActions").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-pa]"); if (!b) return;
  if (b.dataset.pa === "all") { if (photoSel.size === photoCache.length) photoSel.clear(); else photoCache.forEach((p) => photoSel.add(p.id)); renderPhotos(); return; }
  const list = photoCache.filter((p) => photoSel.has(p.id)); if (!list.length) return;
  if (b.dataset.pa === "share") return sharePhotos(list);
  if (b.dataset.pa === "del") {
    if (Date.now() - photoDelArmed > 4000) { photoDelArmed = Date.now(); b.querySelector("span").textContent = "Confirmer ?"; setTimeout(() => (b.querySelector("span").textContent = "Supprimer"), 4000); return; }
    photoDelArmed = 0; await deletePhotos(list.map((p) => p.id)); photoSel.clear(); photoSelecting = false; renderPhotos(); toast(`${list.length} photo${list.length > 1 ? "s" : ""} supprimée${list.length > 1 ? "s" : ""}`);
  }
});
function openViewer(i) {
  if (i < 0 || !photoCache[i]) return;
  viewerIdx = i; const p = photoCache[i];
  $("viewerImg").src = blobUrl(p, "blob");
  $("viewerPos").textContent = `${i + 1} / ${photoCache.length}`;
  const d = new Date(p.createdAt);
  const fake = { code: p.code, nameFR: p.name, nameEN: p.name, lang: REGION[(p.code.split("-")[1] || "").replace(/\d.*$/, "")] || "French", cm: 0 };
  $("viewerInfo").innerHTML = `<strong>${esc(p.name || "Carte non identifiée")}</strong>
    <span class="muted small">${p.code ? `<span class="code">${esc(p.code)}</span> · ` : ""}${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${p.w}×${p.h}</span>
    ${p.code ? `<div class="edit-row">${marketLinks(fake)}</div>` : ""}`;
  $("viewer").hidden = false;
}
let viewerDelArmed = 0;
$("viewer").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-v]"); if (!b) return;
  const a = b.dataset.v;
  if (a === "close") { $("viewer").hidden = true; renderPhotos(); return; }
  if (a === "prev") return openViewer(viewerIdx > 0 ? viewerIdx - 1 : photoCache.length - 1);
  if (a === "next") return openViewer(viewerIdx < photoCache.length - 1 ? viewerIdx + 1 : 0);
  if (a === "share") return sharePhotos([photoCache[viewerIdx]]);
  if (a === "del") {
    if (Date.now() - viewerDelArmed > 4000) { viewerDelArmed = Date.now(); toast("Appuie encore sur la corbeille pour supprimer cette photo"); return; }
    viewerDelArmed = 0; await deletePhotos([photoCache[viewerIdx].id]);
    if (!photoCache.length) { $("viewer").hidden = true; renderPhotos(); return; }
    openViewer(Math.min(viewerIdx, photoCache.length - 1));
  }
});
// swipe between photos
let swipeX = null;
$("viewer").addEventListener("touchstart", (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
$("viewer").addEventListener("touchend", (e) => {
  if (swipeX == null) return; const dx = e.changedTouches[0].clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 60) openViewer(dx < 0 ? (viewerIdx + 1) % photoCache.length : (viewerIdx - 1 + photoCache.length) % photoCache.length);
});
renderCamMode(); loadPhotos();
$("photoInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) scanPhoto(f); });
/* ----- manual add: by set code, or by name with suggestions ----- */
const REGION_OF = { French: "FR", English: "EN", German: "DE", Italian: "IT", Spanish: "SP", Portuguese: "PT" };
let nameIdx = null, cardPrints = null;
function buildNameIndex() {
  if (nameIdx || !DATA) return;
  nameIdx = DATA.cards.map((c, i) => ({ i, fr: fold(c[1]), en: fold(c[0]) }));
  cardPrints = new Map();
  for (const [key, list] of Object.entries(DATA.prints))
    for (const e of list) { if (!cardPrints.has(e[0])) cardPrints.set(e[0], []); cardPrints.get(e[0]).push({ key, set: DATA.sets[e[1]], rarity: e[2] }); }
}
const looksLikeCode = (s) => /^[a-z0-9]{2,5}-[a-z]{0,2}\d/i.test(s.trim());
function searchNames(q) {
  buildNameIndex();
  const f = fold(q); if (f.length < 3) return [];
  const starts = [], inside = [];
  for (const n of nameIdx) {
    if (n.fr.startsWith(f) || n.en.startsWith(f)) starts.push(n);
    else if (n.fr.includes(f) || n.en.includes(f)) inside.push(n);
  }
  // exact name first, then the shortest names (the "base" card before its variants)
  const score = (n) => (n.fr === f || n.en === f ? -1000 : 0) + Math.min(n.fr.length || 999, n.en.length);
  starts.sort((a, b) => score(a) - score(b)); inside.sort((a, b) => score(a) - score(b));
  return [...starts, ...inside].slice(0, 8).map((n) => n.i);
}
function showSuggest(html) { $("suggest").innerHTML = html; $("suggest").hidden = !html; }
function suggestCards(q) {
  if (!DATA || looksLikeCode(q)) return showSuggest("");
  const hits = searchNames(q);
  showSuggest(hits.length ? hits.map((i) => {
    const [en, fr, id] = DATA.cards[i];
    return `<button type="button" class="sug" data-card="${i}">
      <span class="thumb sm">${id ? `<img src="img/${id}.webp" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
      <span class="row-text"><span class="name">${esc(fr || en)}</span>${fr && fr !== en ? `<span class="meta">${esc(en)}</span>` : ""}</span>
      <span class="muted small">${(cardPrints.get(i) || []).length} version${(cardPrints.get(i) || []).length > 1 ? "s" : ""}</span></button>`;
  }).join("") : `<p class="muted small sug-empty">Aucune carte trouvée pour « ${esc(q)} ».</p>`);
}
function suggestPrints(i) {
  const [en, fr] = DATA.cards[i];
  const prints = (cardPrints.get(i) || []).slice().sort((a, b) => a.set.localeCompare(b.set, "fr"));
  showSuggest(`<p class="sug-head"><button type="button" class="link-btn" data-back="1">← Retour</button><strong>${esc(fr || en)}</strong> · choisis la version</p>
    ${prints.map((p) => `<button type="button" class="sug" data-key="${esc(p.key)}" data-rar="${esc(p.rarity)}" data-cardidx="${i}">
      ${rarBadge(p.rarity)}<span class="row-text"><span class="name code">${esc(p.key.replace("-", `-${REGION_OF[settings.lang] || "FR"}`))}</span><span class="meta">${esc(p.set)}</span></span></button>`).join("")}`);
}
let sugT;
$("manualCode").addEventListener("input", (e) => { clearTimeout(sugT); sugT = setTimeout(() => suggestCards(e.target.value), 150); });
$("suggest").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.back) return suggestCards($("manualCode").value);
  if (b.dataset.card) return suggestPrints(Number(b.dataset.card));
  if (b.dataset.key) {
    const region = REGION_OF[settings.lang] || "FR", [pre, num] = b.dataset.key.split("-");
    const it = makeItem({ key: b.dataset.key, code: `${pre}-${region}${num}`, region });
    const c = it.cands.find((x) => x.rarity === b.dataset.rar && x.card === Number(b.dataset.cardidx)) || it.cands.find((x) => x.rarity === b.dataset.rar);
    if (c) applyCandidate(it, c);
    $("manualCode").value = ""; showSuggest(""); commit(it, "manual");
  }
});
$("manualForm").addEventListener("submit", (e) => {
  e.preventDefault(); if (!DATA) return;
  const v = $("manualCode").value;
  const m = matchManual(v);
  if (m) { $("manualCode").value = ""; showSuggest(""); commit(makeItem(m), "manual"); return; }
  const hits = looksLikeCode(v) ? [] : searchNames(v);
  if (hits.length === 1) return suggestPrints(hits[0]);
  if (hits.length) return suggestCards(v);
  toast("Ni code ni nom reconnu. Exemple : MP20-FR167 ou Galant Granite");
});
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }

/* ================= account & sync (Supabase) ================= */
// Public project address and publishable key: safe in the app, the table's row-level security
// only lets each signed-in account read and write its own sessions.
const SUPA_URL = "https://rolyrskjpqlbsiirskko.supabase.co";
const SUPA_KEY = "sb_publishable_k30We2l_8JEPLvNjlxihgg_8lt2vdAd";
const sb = window.supabase?.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "implicit", storageKey: "cs-auth" } }) || null;
// Back from Google / Discord: the access comes in the address (#access_token=…), read it once and clean the address.
const oauthReturn = (() => {
  const h = new URLSearchParams(location.hash.slice(1)), q = new URLSearchParams(location.search);
  const r = { at: h.get("access_token"), rt: h.get("refresh_token"), err: h.get("error_description") || q.get("error_description") };
  if (r.at || r.err) history.replaceState(null, "", location.pathname);
  return r;
})();
let user = null, syncing = false, syncAgain = false, syncTimer = null, lastSync = store.get("cs-lastsync", 0);

function scheduleSync(ms = 2500) { if (!user) return; clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
const iso = (t) => new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
const toRow = (s) => ({ id: s.id, name: s.name, items: s.items, created_at: iso(s.createdAt || s.updatedAt), updated_at: iso(s.updatedAt || s.createdAt), deleted: false });
const isAuthError = (e) => /jwt|token|401|PGRST30/i.test(`${e?.code} ${e?.message} ${e?.status}`);
async function sync() {
  if (!sb || !user || !navigator.onLine || !dataReady) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; setCloud("busy");
  let skipped = [];
  try {
    // Light first pass: only names and dates. The cards of a session are downloaded only when it changed elsewhere.
    const HEAD = "id,name,created_at,updated_at,deleted";
    let { data: remote, error } = await sb.from("scan_sessions").select(HEAD);
    if (error && isAuthError(error)) {
      // access expired while the app was closed: renew it once, then retry
      const { error: re } = await sb.auth.refreshSession();
      if (re) throw re;
      ({ data: remote, error } = await sb.from("scan_sessions").select(HEAD));
    }
    if (error) throw error;
    const dead = store.get("cs-deleted", []);
    const byId = new Map(remote.map((r) => [r.id, r]));
    const needItems = remote.filter((r) => {
      if (r.deleted || dead.some((d) => d.id === r.id && d.at >= Date.parse(r.updated_at))) return false;
      const l = sessions.find((s) => s.id === r.id);
      return !l || Date.parse(r.updated_at) > (l.updatedAt || 0);
    }).map((r) => r.id);
    const remoteItems = new Map();
    for (let i = 0; i < needItems.length; i += 10) {
      const { data, error: ei } = await sb.from("scan_sessions").select("id,items").in("id", needItems.slice(i, i + 10));
      if (ei) throw ei;
      for (const r of data) remoteItems.set(r.id, r.items || []);
    }
    let changedLocal = false;
    // 1. bring remote changes in
    for (const r of remote) {
      const rt = Date.parse(r.updated_at), l = sessions.find((s) => s.id === r.id);
      if (r.deleted) { if (l && (l.updatedAt || 0) <= rt) { sessions = sessions.filter((s) => s !== l); changedLocal = true; } continue; }
      if (!remoteItems.has(r.id)) continue;
      if (!l) { sessions.push({ id: r.id, name: r.name, items: remoteItems.get(r.id), createdAt: Date.parse(r.created_at), updatedAt: rt }); changedLocal = true; }
      else { l.name = r.name; l.items = remoteItems.get(r.id); l.updatedAt = rt; changedLocal = true; }
    }
    // 2. send local changes and deletions out
    // (a brand-new empty session stays local until it holds a card, so devices don't pile up empty lists)
    const up = sessions.filter((s) => { const r = byId.get(s.id); return r ? (s.updatedAt || 0) > Date.parse(r.updated_at) : s.items.length > 0; }).map(toRow);
    // Deleted sessions are sent as "deleted" rows with every column filled: in a batch, a missing
    // column is sent as null, and created_at may not be null.
    for (const d of dead) if (!byId.get(d.id)?.deleted) {
      const r = byId.get(d.id);
      up.push({ id: d.id, name: r?.name || "", items: [], created_at: r?.created_at || iso(d.at), updated_at: iso(d.at), deleted: true });
    }
    if (up.length) {
      const { error: e2 } = await sb.from("scan_sessions").upsert(up, { defaultToNull: false });
      if (e2) {
        if (isAuthError(e2)) throw e2;
        // One bad session must not block the others: send them one by one and set aside the ones refused.
        for (const row of up) {
          const { error: e3 } = await sb.from("scan_sessions").upsert([row], { defaultToNull: false });
          if (e3) { console.warn("session refused", row.id, e3); skipped.push({ row, e: e3 }); }
        }
      }
    }
    store.set("cs-deleted", []);
    if (changedLocal) {
      if (!sessions.length) sessions = [newSession()];
      sessions.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
      if (!sessions.includes(current)) { current = sessions[0]; lastAdded = null; }
      else items = current.items;
      items = current.items;
      persist(); renderList(); renderSessionBar(); renderLast();
      if (!$("sheet").hidden) renderSessions();
    }
    lastSync = Date.now(); store.set("cs-lastsync", lastSync);
    if (skipped.length) {
      const e = skipped[0].e, name = skipped[0].row.name || "session supprimée";
      setCloud("err", `${skipped.length} session(s) non envoyée(s), dont « ${name} » (${[e.code, e.message].filter(Boolean).join(" · ").slice(0, 140)}). Les autres sont synchronisées.`);
    } else setCloud("ok");
  } catch (e) {
    console.warn(e);
    const detail = [e?.code, e?.message || String(e)].filter(Boolean).join(" · ").slice(0, 160);
    setCloud("err", `La synchronisation a échoué (${detail}). Nouvel essai automatique.`);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}
function setCloud(state, msg) {
  $("cloudDot").className = "cloud " + (state || "");
  if (!user) return;
  updateHomeSync(state);
  if (view === "home" && state === "ok") renderHome();
  $("accStatus").textContent = msg || (state === "busy" ? "Synchronisation…" : lastSync ? `Synchronisé à ${new Date(lastSync).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "Connecté");
}
function renderAccount() {
  const on = !!user;
  $("accTitle").textContent = on ? (user.email || user.user_metadata?.full_name || "Compte connecté") : "Compte";
  $("accGuest").hidden = on; $("accActions").hidden = !on;
  if (on) setCloud(lastSync ? "ok" : "");
  else { $("cloudDot").className = "cloud"; $("accStatus").textContent = "Sans compte : tes sessions restent sur cet appareil."; }
  updateHomeSync();
}
let authMode = "in";
$("authMode").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]"); if (!b) return;
  authMode = b.dataset.mode;
  $("authMode").querySelectorAll(".seg").forEach((s) => s.classList.toggle("on", s === b));
  $("authSubmit").textContent = authMode === "up" ? "Créer mon compte" : "Se connecter";
  $("loginPass").setAttribute("autocomplete", authMode === "up" ? "new-password" : "current-password");
});
$("guestBtn").addEventListener("click", () => { store.set("cs-guest", true); showView("home"); });
$("toAuthBtn").addEventListener("click", () => showView("auth"));
// E-mail + password: works without an e-mail sending service (Supabase "Confirm email" turned off).
function authError(m = "") {
  if (/invalid login credentials/i.test(m)) return "E-mail ou mot de passe incorrect.";
  if (/already registered|already exists/i.test(m)) return "Ce compte existe déjà : utilise « Se connecter ».";
  if (/password should be|at least/i.test(m)) return "Mot de passe trop court : 8 caractères minimum.";
  if (/email not confirmed/i.test(m)) return "Compte non confirmé : désactive « Confirm email » dans Supabase (voir le guide).";
  if (/rate limit|too many/i.test(m)) return "Trop de tentatives : réessaie dans une minute.";
  if (/fetch|network/i.test(m)) return "Pas de connexion internet.";
  if (/provider is not enabled|unsupported provider/i.test(m)) return "Ce mode de connexion n'est pas encore activé.";
  if (/access_denied|denied|cancel/i.test(m)) return "Connexion annulée.";
  return "Connexion impossible : " + m;
}
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!sb) { toast("Connexion indisponible pour le moment. Vérifie ta connexion internet."); return; }
  const email = $("loginEmail").value.trim(), password = $("loginPass").value;
  if (!email || password.length < 8) { toast("Entre ton e-mail et un mot de passe d'au moins 8 caractères."); return; }
  const signup = authMode === "up";
  $("authSubmit").disabled = true; $("authSubmit").textContent = signup ? "Création…" : "Connexion…";
  const { data, error } = signup ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
  $("authSubmit").disabled = false; $("authSubmit").textContent = signup ? "Créer mon compte" : "Se connecter";
  if (error) { toast(authError(error.message)); return; }
  if (signup && !data.session) { toast(authError("email not confirmed")); return; }
  user = data.session.user; store.set("cs-guest", false);
  $("loginPass").value = ""; renderAccount(); showView("home");
  toast(signup ? "Compte créé, bienvenue !" : "Connecté");
});
// Google / Discord: shown only once turned on in Supabase (Authentication → Providers).
async function showOAuthButtons() {
  try {
    const r = await fetch(`${SUPA_URL}/auth/v1/settings`, { headers: { apikey: SUPA_KEY }, cache: "no-store" });
    const ext = (await r.json()).external || {};
    let any = false;
    for (const b of document.querySelectorAll("[data-provider]")) { b.hidden = !ext[b.dataset.provider]; any ||= !b.hidden; }
    $("oauthBox").hidden = !any;
  } catch { /* offline: e-mail only */ }
}
$("oauthBox").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-provider]"); if (!b) return;
  if (!sb || !navigator.onLine) { toast("Pas de connexion internet."); return; }
  b.disabled = true;
  const { error } = await sb.auth.signInWithOAuth({ provider: b.dataset.provider, options: { redirectTo: location.origin + location.pathname } });
  if (error) { b.disabled = false; toast(authError(error.message)); }
  setTimeout(() => { b.disabled = false; }, 8000); // came back without signing in
});
if (sb) showOAuthButtons();
if (sb && oauthReturn.at) {
  store.set("cs-guest", false);
  sb.auth.setSession({ access_token: oauthReturn.at, refresh_token: oauthReturn.rt || "" })
    .then(({ error }) => toast(error ? authError(error.message) : "Connecté"));
} else if (oauthReturn.err) setTimeout(() => toast(authError(oauthReturn.err)), 600);
$("syncBtn").addEventListener("click", () => sync());
$("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut(); store.set("cs-guest", false);
  showView("auth"); toast("Déconnecté. Tes sessions restent sur cet appareil.");
});
// First screen: the home page when signed in (or when the person chose to go on without an account), else sign-in.
let routed = false;
// A session saved on this phone counts as signed in right away: confirming it with Supabase can take
// several seconds after a long pause (the access token is renewed first), and we must not show the
// sign-in screen meanwhile. If the session really is invalid, Supabase sends SIGNED_OUT and we go back.
const hasStoredSession = () => { try { return !!localStorage.getItem("cs-auth"); } catch { return false; } };
function route() {
  if (routed) return; routed = true;
  showView(user || hasStoredSession() || oauthReturn.at || store.get("cs-guest", false) ? "home" : "auth");
  $("splash").hidden = true;
}
setTimeout(route, 2500); // never stay on the splash (no network, auth library missing…)
if (sb) {
  sb.auth.onAuthStateChange((ev, session) => {
    const was = user?.id; user = session?.user || null; renderAccount();
    if (user && user.id !== was) scheduleSync(200);
    if (ev === "INITIAL_SESSION") route();
    if (user && view === "auth" && ev !== "SIGNED_OUT") showView("home"); // session confirmed after a slow start
    if (ev === "SIGNED_OUT" && view && view !== "auth") showView("auth");
    if (view === "home") renderHome();
  });
  window.addEventListener("online", () => scheduleSync(500));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleSync(800); });
  setInterval(() => { if (!document.hidden) scheduleSync(0); }, 60000);
}

/* ================= boot ================= */
bindSettings(); renderList(); renderSessionBar(); renderLast(); renderAccount(); renderStockInfo(); loadData(); loadSessions();
if (!sb) route();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
window.__cs = { // debug helpers
  matchAll, matchManual, buildCsv, grab, detectText, recognize, readCodes, celebrate, get items() { return items; }, get DATA() { return DATA; },
  async testStream(s) { stream = s; video.srcObject = s; await video.play(); await getEngine(); scanning = wantScan = true; reads = []; changed = true; loop(); },
};
