/* Card Scanner — reconnaissance du code de set sur le téléphone (PaddleOCR + ONNX Runtime), sans serveur. */
const APP_VERSION = "6";
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
const settings = Object.assign({ cond: "NM", lang: "French", comment: "", priceTrend: false, sound: true, debug: false, torch: false }, store.get("cs-settings", {}));

/* ----- sessions: one list per scanning session ----- */
function newSession(itemsIn = []) {
  const d = new Date();
  return { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), items: itemsIn,
    name: `${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" })} · ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` };
}
let sessions = store.get("cs-sessions", null);
if (!Array.isArray(sessions) || !sessions.length) sessions = [newSession(store.get("cs-items", []))]; // migrate the single list of v1–v4
let current = sessions.find((s) => s.id === store.get("cs-current", "")) || sessions[0];
let items = current.items;
function saveItems() {
  current.items = items; current.updatedAt = Date.now();
  if (!store.set("cs-sessions", sessions) || !store.set("cs-current", current.id)) toast("Impossible d'enregistrer sur ce téléphone. Exporte ta liste.");
  renderList(); renderSessionBar();
}
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
  let boxes = (await detectText(c)).filter((b) => b.w > b.h * 2);
  // detected boxes are padded ("unclip"): about 2.5× the height of the letters
  if (textH) boxes = boxes.filter((b) => b.h > textH * 0.6 && b.h < textH * 4.5);
  if (prefer) boxes.sort((a, b) => prefer(a) - prefer(b));
  const lines = [];
  for (const b of boxes.slice(0, maxLines)) {
    const text = await recognize(c, b);
    const matches = matchAll(text.toUpperCase());
    lines.push({ box: b, text, matches });
    if (matches.some((m) => !m.unsure) && prefer) break;
  }
  return { boxes, lines, matches: lines.flatMap((l) => l.matches) };
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

async function startCamera() {
  if (!DATA) { toast("La base de cartes charge encore…"); return; }
  try {
    if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
    audioCtx?.resume?.();
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
    video.srcObject = stream; await video.play();
    try { const tr = stream.getVideoTracks()[0]; const caps = tr.getCapabilities?.() || {}; if (caps.focusMode?.includes("continuous")) await tr.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
    $("torchBtn").hidden = false;
    if (settings.torch) setTorch(true, true);
  } catch (e) {
    stopCamera(false);
    setStatus(e && e.name === "NotAllowedError" ? "Accès à la caméra refusé. Autorise-le dans Réglages › Safari › Caméra." : "Caméra indisponible sur cet appareil. Utilise « Photo » ou tape le code.");
    return;
  }
  try {
    setStatus("Chargement du moteur de lecture (une seule fois)…");
    await getEngine();
  } catch (e) {
    console.warn(e); stopCamera(false);
    setStatus("Le moteur de lecture n'a pas pu démarrer. Vérifie ta connexion puis réessaie."); return;
  }
  scanning = wantScan = true; reads = []; changed = true;
  $("startBtn").textContent = "Pause";
  setStatus("Place une carte dans le cadre");
  loop();
}
/* ----- flash (torch). iOS 17+ accepts the "torch" constraint but may not report it back, so we keep our own state. */
let torchOn = false;
async function setTorch(on, quiet = false) {
  const tr = stream?.getVideoTracks()[0];
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
  // stopping the camera turns the flash off; settings.torch is kept so it comes back on next start
  torchOn = false; $("torchBtn").classList.remove("on"); $("torchBtn").hidden = true;
  scanning = false; if (!keepWanted) wantScan = false;
  stream?.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null;
  try { wakeLock?.release(); } catch {} wakeLock = null;
  $("startBtn").textContent = "Démarrer";
  if (!keepWanted) setStatus("En pause");
}
async function loop() {
  while (scanning) {
    try { await scanFrame(); } catch (e) { console.warn(e); await sleep(300); }
    await sleep(0);
  }
}
// The lower part of the card holds the set code (right, under the artwork; bottom-left on Pendulum
// cards) and the "1st Edition" mention. Reading this whole area tolerates a badly placed card.
const LOWER = { y: 0.56, h: 0.46, x: -0.04, w: 1.08 };
let sawEmpty = true; // a frame without any readable code since the last card was added
async function scanFrame() {
  if (!video.videoWidth) { await sleep(100); return; }
  const r = guideInVideo();
  const sig = signature(r);
  if (!changed) {
    // The card just added is still in front of the camera: only watch (cheaply) for it to move away.
    if (sigDiff(sig, last.sig) > 22) { if (++changedHits >= 2) { changed = true; reads = []; sawEmpty = false; setStatus("Recherche du code…"); } }
    else changedHits = 0;
    if (!changed) { await sleep(120); return; }
  }
  const zx = Math.max(0, r.x + r.w * LOWER.x), zy = Math.max(0, r.y + r.h * LOWER.y);
  const zw = Math.min(video.videoWidth - zx, r.w * LOWER.w), zh = Math.min(video.videoHeight - zy, r.h * LOWER.h);
  const zone = grab(video, zx, zy, zw, zh, 960);
  const k = zone.height / zh, textH = r.h * 0.017 * k;
  // try first the line under the artwork on the right, then the rest
  const prefer = (b) => Math.abs((b.y + b.h / 2) / zone.height - 0.3) + (b.x + b.w > zone.width * 0.7 ? 0 : 0.3);
  const res = await readCodes(zone, { textH, prefer, maxLines: 5 });
  if (!scanning) return;
  if (settings.debug) showDebug(zone, res, r);
  const m = res.matches.find((x) => !x.unsure) || null;
  reads.push(m ? m.key : null); if (reads.length > 4) reads.shift();
  if (!m) { if (!res.boxes.length || res.lines.every((l) => !l.text)) sawEmpty = true; setStatus("Recherche du code…"); return; }
  // Same code as the card just added and the camera never saw the card leave: it is the same card being moved.
  if (last && m.key === last.key && !sawEmpty) { setStatus(`Déjà ajoutée : <span class="code">${esc(m.code)}</span> — présente la suivante`); changed = false; last.sig = sig; return; }
  const hits = reads.filter((k) => k === m.key).length;
  if (m.exact || hits >= 2) {
    const firstEd = await detectEdition(zone, res.boxes, textH);
    const it = makeItem(m, { firstEd });
    commit(it, "scan");
    last = { sig, key: m.key }; changed = false; changedHits = 0; reads = []; sawEmpty = false;
    celebrate(it); beep();
    setStatus(`Ajoutée : <span class="code">${esc(m.code)}</span> — présente la suivante`);
  } else setStatus(`Lu : <span class="code">${esc(m.code)}</span> — vérification…`);
}
async function detectEdition(zone, boxes, textH) {
  try {
    const cands = boxes.filter((b) => b.y > zone.height * 0.7 && b.x < zone.width * 0.5 && b.h < textH * 4.5)
      .sort((a, b) => b.y - a.y).slice(0, 3);
    for (const b of cands) if (/EDI[TC]|DITION|AUFLAGE|EDIZ|1ST|1RE|1\.?\s?A/i.test(await recognize(zone, b))) return true;
  } catch {}
  return false;
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
function celebrate(it) {
  bump($("guide"), "hit");
  const fly = document.createElement("div");
  fly.className = "fly";
  fly.innerHTML = `<span class="code">${esc(it.code)}</span><span>${esc(it.nameFR)}</span>`;
  $("stage").append(fly);
  fly.addEventListener("animationend", () => fly.remove());
  setTimeout(() => fly.remove(), 1500);
  bump($("tabCount")); bump($("sessionCount"));
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
function renderLast() {
  const box = $("last");
  const it = lastAdded && items.find((x) => x.id === lastAdded.id);
  if (!it) { box.hidden = true; return; }
  const fresh = box.dataset.id !== it.id + ":" + it.qty;
  box.dataset.id = it.id + ":" + it.qty;
  box.hidden = false; box.className = "last" + (it.rarity ? "" : " todo") + (fresh ? " enter" : "");
  const p = priceText(cmPrice(it.cm));
  box.innerHTML = `
    <div class="row1"><span class="name">${esc(it.nameFR)}</span><span class="price">${esc(p || "cote ?")}</span></div>
    <div class="sub"><span class="code">${esc(it.code)}</span> · ${esc(it.set)} · <span class="lang">${LANG_SHORT[it.lang] || ""}</span>${it.qty > 1 ? ` · ×${it.qty}` : ""}</div>
    ${it.cands.length > 1 ? `<div class="sub">${it.rarity ? "Rareté :" : "<span class=flag>Choisis la rareté :</span>"}</div>
      <div class="chips">${it.cands.map((c) => `<button class="chip ${c.rarity === it.rarity ? "on" : ""}" data-rar="${esc(c.rarity)}">${esc(c.rarity)}</button>`).join("")}</div>`
      : `<div class="chips"><span class="chip on">${esc(it.rarity)}</span></div>`}
    <div class="chips">
      <button class="chip ${it.firstEd ? "on" : ""}" data-act="ed">1re édition</button>
      <button class="chip" data-act="plus">+1 exemplaire</button>
      <button class="chip" data-act="undo">Annuler</button>
      <a class="chip" href="${cmLink(it)}" target="_blank" rel="noopener">Voir sur Cardmarket (${LANG_SHORT[it.lang] || "FR"}) ↗</a>
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

let filter = "all";
function renderList() {
  const total = items.reduce((n, x) => n + x.qty, 0);
  let value = 0, priced = 0;
  for (const x of items) { const p = cmPrice(x.cm); if (p && p.lo === p.hi) { value += p.lo * x.qty; priced += x.qty; } }
  $("tabCount").textContent = total;
  if (document.activeElement !== $("sessionTitle")) $("sessionTitle").value = current.name;
  $("totals").textContent = `${total} carte${total > 1 ? "s" : ""}` + (priced ? ` · cote ≈ ${eur(value)}${priced < total ? ` (sur ${priced})` : ""}` : "");
  const todo = items.filter((x) => !x.rarity).length;
  $("exportNote").textContent = todo ? `${todo} ligne${todo > 1 ? "s" : ""} sans rareté : elles ne seront pas exportées tant que tu ne l'as pas choisie.` : "";
  const shown = filter === "todo" ? items.filter((x) => !x.rarity) : items;
  $("empty").hidden = items.length > 0;
  $("list").innerHTML = shown.map((it) => {
    const p = priceText(cmPrice(it.cm));
    const isNew = Date.now() - it.createdAt < 1500;
    return `<div class="item ${it.rarity ? "" : "todo"} ${isNew ? "enter" : ""}" data-id="${it.id}">
      <div class="row1" style="display:flex;justify-content:space-between;gap:8px"><span class="name">${esc(it.nameFR)}</span><span class="price">${esc(p)}</span></div>
      <div class="sub"><span class="code">${esc(it.code)}</span> · ${esc(it.set)}</div>
      <a class="cm-link" href="${cmLink(it)}" target="_blank" rel="noopener">Voir sur Cardmarket (${LANG_SHORT[it.lang] || "FR"}) ↗</a>
      <div class="row">
        ${it.cands.length > 1 ? `<select data-f="rarity" aria-label="Rareté">${it.rarity ? "" : `<option value="">Rareté ?</option>`}${it.cands.map((c) => `<option ${c.rarity === it.rarity ? "selected" : ""}>${esc(c.rarity)}</option>`).join("")}</select>` : `<span class="chip on">${esc(it.rarity)}</span>`}
        <button class="chip ${it.firstEd ? "on" : ""}" data-act="ed">1re éd.</button>
        <select data-f="condition" aria-label="État">${COND.map((c) => `<option ${c === it.condition ? "selected" : ""}>${c}</option>`).join("")}</select>
        <select data-f="lang" aria-label="Langue">${LANGS.map((l) => `<option value="${l}" ${l === it.lang ? "selected" : ""}>${LANG_SHORT[l]}</option>`).join("")}</select>
      </div>
      <div class="row">
        <span class="qty"><button data-act="minus" aria-label="Moins">−</button><span>${it.qty}</span><button data-act="plus" aria-label="Plus">+</button></span>
        <input class="price-in" data-f="price" inputmode="decimal" placeholder="Prix €" value="${esc(it.price)}" aria-label="Prix">
        <input data-f="comment" placeholder="Commentaire" value="${esc(it.comment)}" aria-label="Commentaire" style="flex:1;min-width:90px">
        <button class="del" data-act="del">Supprimer</button>
      </div>
    </div>`;
  }).join("");
}
const itemOf = (el) => items.find((x) => x.id === el.closest("[data-id]")?.dataset.id);
$("list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const it = itemOf(b); if (!it) return;
  const a = b.dataset.act;
  if (a === "plus") it.qty += 1;
  else if (a === "minus") { if (it.qty <= 1) return; it.qty -= 1; }
  else if (a === "ed") it.firstEd = !it.firstEd;
  else if (a === "del") items = items.filter((x) => x !== it);
  saveItems(); renderLast();
});
$("list").addEventListener("change", (e) => {
  const f = e.target.dataset.f; const it = itemOf(e.target); if (!f || !it) return;
  if (f === "rarity") setRarity(it, e.target.value);
  else if (f === "price") it.price = e.target.value.trim().replace(",", ".");
  else it[f] = e.target.value.trim();
  saveItems(); renderLast();
});
document.querySelector(".filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]"); if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll(".filters .chip").forEach((c) => c.classList.toggle("on", c === b));
  renderList();
});

/* ================= sessions UI ================= */
function sessionStats(s) {
  let n = 0, v = 0; for (const x of s.items) { n += x.qty; const p = cmPrice(x.cm); if (p && p.lo === p.hi) v += p.lo * x.qty; }
  return { n, v };
}
function renderSessionBar() {
  $("sessionName").textContent = current.name;
  const { n } = sessionStats(current);
  $("sessionCount").textContent = `${n} carte${n > 1 ? "s" : ""}`;
}
function deleteSession(s) {
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
        <span class="sub">${n} carte${n > 1 ? "s" : ""}${v ? ` · ≈ ${eur(v)}` : ""} · ${d}${s === current ? " · en cours" : ""}</span></button>
      <button class="del" data-act="del">${delArmed === s.id ? "Confirmer ?" : "Supprimer"}</button>
    </div>`;
  }).join("");
}
function openSheet() { delArmed = null; renderSessions(); $("sheet").hidden = false; }
$("sessionsBtn").addEventListener("click", openSheet);
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
function buildCsv() {
  const rows = new Map();
  for (const it of items) {
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
  const slug = current.name.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
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
  const save = () => {
    Object.assign(settings, { cond: $("setCond").value, lang: $("setLang").value, comment: $("setComment").value.trim(), priceTrend: $("setPriceTrend").checked, sound: $("setSound").checked, debug: $("setDebug").checked });
    store.set("cs-settings", settings);
    if (!settings.debug) $("debug").hidden = true;
  };
  ["setCond", "setLang", "setComment", "setPriceTrend", "setSound", "setDebug"].forEach((id) => $(id).addEventListener("change", save));
}
let clearArmed = 0;
$("clearBtn").addEventListener("click", () => {
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); $("clearBtn").textContent = "Confirmer : supprimer cette session ?"; setTimeout(() => ($("clearBtn").textContent = "Supprimer cette session"), 4000); return; }
  clearArmed = 0; deleteSession(current); $("clearBtn").textContent = "Supprimer cette session"; toast("Session supprimée");
});
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab"); if (!b) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === b));
  const v = b.dataset.view;
  $("view-scan").hidden = v !== "scan"; $("view-list").hidden = v !== "list";
  if (v === "list" && scanning) stopCamera(true);
  if (v === "scan" && wantScan && !scanning) startCamera();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && scanning) stopCamera(true);
  else if (!document.hidden && wantScan && !scanning && !$("view-scan").hidden) startCamera();
});
$("startBtn").addEventListener("click", () => scanning ? stopCamera() : startCamera());
$("photoInput").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) scanPhoto(f); });
$("manualForm").addEventListener("submit", (e) => {
  e.preventDefault(); if (!DATA) return;
  const m = matchManual($("manualCode").value);
  if (!m) { toast("Code introuvable. Format : MP20-FR167"); return; }
  $("manualCode").value = ""; commit(makeItem(m), "manual");
});
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2800); }

/* ================= boot ================= */
bindSettings(); renderList(); renderSessionBar(); renderLast(); loadData();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
window.__cs = { // debug helpers
  matchAll, matchManual, buildCsv, grab, detectText, recognize, readCodes, get DATA() { return DATA; },
  async testStream(s) { stream = s; video.srcObject = s; await video.play(); await getEngine(); scanning = wantScan = true; reads = []; changed = true; loop(); },
};
