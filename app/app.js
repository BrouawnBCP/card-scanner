/* Card Scanner — reconnaissance du code de set dans le navigateur (Tesseract), sans serveur. */
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
let items = store.get("cs-items", []);
const settings = Object.assign({ cond: "NM", lang: "French", comment: "", priceTrend: false, sound: true, debug: false }, store.get("cs-settings", {}));
function saveItems() { if (!store.set("cs-items", items)) toast("Impossible d'enregistrer la liste sur ce téléphone. Exporte-la."); renderList(); }
navigator.storage?.persist?.().catch(() => {});

/* ================= card data ================= */
let DATA = null, PREFIXES = null;
async function loadData() {
  try {
    const r = await fetch("data/cards.json");
    DATA = await r.json();
    PREFIXES = new Set(Object.keys(DATA.prints).map((k) => k.slice(0, k.indexOf("-"))));
    $("dataInfo").textContent = `Base : ${DATA.cards.length.toLocaleString("fr-FR")} cartes · cotes Cardmarket du ${new Date(DATA.v).toLocaleDateString("fr-FR")}`;
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
  let nums = [""];
  for (const c of s.slice(-3)) {
    const opts = /\d/.test(c) ? [c] : (L2DS[c] || []);
    if (!opts.length) return null;
    nums = nums.flatMap((n) => opts.map((o) => n + o));
  }
  let reg = s.slice(0, -3).replace(/\d/g, (c) => D2L[c] || "");
  if (reg.length > 2) reg = reg.slice(-2);
  if (!REGION[reg] && REGION_FIX[reg]) reg = REGION_FIX[reg];
  return { region: REGION[reg] ? reg : "", nums };
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
  for (const f of found) if (!out.some((o) => o.key === f.key)) out.push({ ...f, unsure: found.length > 1 });
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

/* ================= OCR ================= */
const WL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
let workerP = null, ocrMode = "";
function getWorker() {
  if (!workerP) {
    const base = new URL("vendor/tesseract/", location.href).href;
    workerP = Tesseract.createWorker("eng", 1, { workerPath: base + "worker.min.js", corePath: base, langPath: base, workerBlobURL: false })
      .catch((e) => { workerP = null; throw e; });
  }
  return workerP;
}
async function ocr(canvas, mode) {
  const w = await getWorker();
  if (mode !== ocrMode) {
    const p = mode === "band" ? { tessedit_char_whitelist: WL, tessedit_pageseg_mode: "6" }
      : mode === "sparse" ? { tessedit_char_whitelist: WL, tessedit_pageseg_mode: "11" }
      : { tessedit_char_whitelist: "", tessedit_pageseg_mode: "6" };
    await w.setParameters(p); ocrMode = mode;
  }
  const { data } = await w.recognize(canvas);
  return data.text || "";
}
/** Crop a region, upscale, grayscale and stretch contrast. */
function prep(src, sx, sy, sw, sh, { targetH = 300, invert = false, binarize = false, maxW = 2200 } = {}) {
  let scale = Math.min(Math.max(targetH / sh, 1), 4);
  if (sw * scale > maxW) scale = maxW / sw;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; d[i] = y; hist[y]++; }
  const n = d.length / 4; let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
  const k = 255 / Math.max(1, hi - lo);
  const h2 = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { let v = (d[i] - lo) * k; v = v < 0 ? 0 : v > 255 ? 255 : v | 0; if (invert) v = 255 - v; d[i] = d[i + 1] = d[i + 2] = v; h2[v]++; }
  if (binarize) {
    // Otsu threshold: pure black text on white, helps with glare and textured card frames.
    let sum = 0; for (let v = 0; v < 256; v++) sum += v * h2[v];
    let sB = 0, wB = 0, best = 0, th = 128;
    for (let v = 0; v < 256; v++) {
      wB += h2[v]; if (!wB) continue; const wF = n - wB; if (!wF) break;
      sB += v * h2[v]; const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; th = v; }
    }
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = d[i] > th ? 255 : 0;
  }
  g.putImageData(im, 0, 0);
  return c;
}

/* ================= camera scanning ================= */
const video = $("video");
let stream = null, scanning = false, wantScan = false, audioCtx = null, wakeLock = null;
let reads = [], last = null /* {sig} */, changed = true, changedHits = 0, frameNo = 0;
// Each frame tries a slightly different reading so a badly placed or shiny card still gets read.
const MODES = [
  { zone: "code" }, { zone: "code", binarize: true }, { zone: "code", dy: -0.045 }, { zone: "code", dy: 0.045, binarize: true },
  { zone: "code" }, { zone: "code", invert: true }, { zone: "code", dy: -0.045, binarize: true }, { zone: "pend" },
];
// Zones relative to the guide (card) rectangle.
const ZONES = { code: [0.36, 0.655, 0.64, 0.155], pend: [0.0, 0.885, 0.62, 0.115], edition: [0.0, 0.9, 0.6, 0.1] };

function guideInVideo() {
  const st = $("stage").getBoundingClientRect(), gr = $("guide").getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(st.width / vw, st.height / vh);
  const ox = (st.width - vw * s) / 2, oy = (st.height - vh * s) / 2;
  return { x: (gr.left - st.left - ox) / s, y: (gr.top - st.top - oy) / s, w: gr.width / s, h: gr.height / s };
}
function zoneRect(r, z) { const [x, y, w, h] = ZONES[z]; return [r.x + r.w * x, r.y + r.h * y, r.w * w, r.h * h]; }
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
    setStatus("Préparation de la lecture…");
    await getWorker();
    scanning = wantScan = true; reads = []; changed = true;
    $("startBtn").textContent = "Pause";
    setStatus("Place une carte dans le cadre, code de set dans la zone pointillée");
    loop();
  } catch (e) {
    stopCamera(false);
    setStatus(e && e.name === "NotAllowedError" ? "Accès à la caméra refusé. Autorise-le dans Réglages › Safari › Caméra." : "Caméra indisponible sur cet appareil. Utilise « Photo » ou tape le code.");
  }
}
function stopCamera(keepWanted = false) {
  scanning = false; if (!keepWanted) wantScan = false;
  stream?.getTracks().forEach((t) => t.stop()); stream = null; video.srcObject = null;
  try { wakeLock?.release(); } catch {} wakeLock = null;
  $("startBtn").textContent = "Démarrer";
  if (!keepWanted) setStatus("En pause");
}
async function loop() {
  while (scanning) {
    try { await scanFrame(); } catch (e) { console.warn(e); await sleep(300); }
    await sleep(30);
  }
}
async function scanFrame() {
  if (!video.videoWidth) { await sleep(100); return; }
  const r = guideInVideo();
  const sig = signature(r);
  if (!changed && last) {
    if (sigDiff(sig, last.sig) > 22) { if (++changedHits >= 2) { changed = true; reads = []; } }
    else changedHits = 0;
  }
  const mode = MODES[frameNo++ % MODES.length];
  const [x, y0, w, h] = zoneRect(r, mode.zone);
  const y = Math.max(0, y0 + (mode.dy || 0) * r.h);
  const crop = prep(video, x, y, w, h, mode);
  const text = await ocr(crop, "band");
  if (!scanning) return;
  const all = matchAll(text);
  if (settings.debug) showDebug(crop, text, all, mode, r);
  const m = all.find((x) => !x.unsure) || null;
  reads.push(m ? m.key : null); if (reads.length > 4) reads.shift();
  if (!m) { if (!changed) setStatus("Retire la carte et présente la suivante"); else setStatus("Recherche du code…"); return; }
  if (!changed) { setStatus(`Déjà ajoutée : <span class="code">${esc(m.code)}</span> — présente la suivante`); return; }
  const hits = reads.filter((k) => k === m.key).length;
  setStatus(`Lu : <span class="code">${esc(m.code)}</span> (${hits}/2)`);
  if (hits >= 2) {
    const firstEd = await detectEdition(r);
    const it = makeItem(m, { firstEd });
    commit(it, "scan");
    last = { sig }; changed = false; changedHits = 0; reads = [];
    flash(); beep();
  }
}
async function detectEdition(r) {
  try {
    const [x, y, w, h] = zoneRect(r, "edition");
    const t = await ocr(prep(video, x, y, w, h, { targetH: 120 }), "text");
    return /EDI[TC]|DITION|AUFLAGE|EDIZ|1ST|1RE|1\.?\s?A/i.test(t);
  } catch { return false; }
}
function showDebug(crop, text, matches, mode, r) {
  const c = $("debugCanvas"); c.width = crop.width; c.height = crop.height;
  c.getContext("2d").drawImage(crop, 0, 0);
  const opts = [mode.zone, mode.binarize && "seuillage", mode.invert && "inversé", mode.dy && `décalage ${mode.dy > 0 ? "+" : ""}${mode.dy}`].filter(Boolean).join(", ");
  $("debugText").textContent = `Texte lu : ${text.trim().replace(/\n+/g, " ⏎ ") || "(rien)"}\nCode(s) reconnu(s) : ${matches.map((m) => m.code + (m.unsure ? " (incertain)" : "")).join(", ") || "aucun"}\nRéglage : ${opts}\nVidéo ${video.videoWidth}×${video.videoHeight} · carte ${Math.round(r.w)}×${Math.round(r.h)} px`;
  $("debug").hidden = false;
}
function flash() { const g = $("guide"); g.classList.add("hit"); setTimeout(() => g.classList.remove("hit"), 700); }
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
      const t = await ocr(prep(src, 0, 0, src.width, src.height, { targetH: src.height, maxW: 2400 }), "sparse");
      for (const m of matchAll(t)) if (!found.some((f) => f.key === m.key)) found.push(m);
      if (found.length) break;
    }
    if (!found.length) { setStatus("Aucun code lu sur cette photo. Rapproche-toi du code de set."); toast("Aucun code trouvé"); return; }
    for (const m of found) commit(makeItem(m), "photo");
    setStatus(`${found.length} carte${found.length > 1 ? "s" : ""} ajoutée${found.length > 1 ? "s" : ""} depuis la photo`);
  } catch (e) { console.warn(e); setStatus("Cette photo n'a pas pu être analysée."); }
}
function rotate(bmp, deg) {
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
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
const cmLink = (it) => `https://www.cardmarket.com/fr/YuGiOh/Products/Search?searchString=${encodeURIComponent(it.nameEN || "")}`;

/* ================= rendering ================= */
function renderLast() {
  const box = $("last");
  const it = lastAdded && items.find((x) => x.id === lastAdded.id);
  if (!it) { box.hidden = true; return; }
  box.hidden = false; box.className = "last" + (it.rarity ? "" : " todo");
  const p = priceText(cmPrice(it.cm));
  box.innerHTML = `
    <div class="row1"><span class="name">${esc(it.nameFR)}</span><span class="price">${esc(p || "cote ?")}</span></div>
    <div class="sub"><span class="code">${esc(it.code)}</span> · ${esc(it.set)} · ${LANG_SHORT[it.lang] || ""}${it.qty > 1 ? ` · ×${it.qty}` : ""}</div>
    ${it.cands.length > 1 ? `<div class="sub">${it.rarity ? "Rareté :" : "<span class=flag>Choisis la rareté :</span>"}</div>
      <div class="chips">${it.cands.map((c) => `<button class="chip ${c.rarity === it.rarity ? "on" : ""}" data-rar="${esc(c.rarity)}">${esc(c.rarity)}</button>`).join("")}</div>`
      : `<div class="chips"><span class="chip on">${esc(it.rarity)}</span></div>`}
    <div class="chips">
      <button class="chip ${it.firstEd ? "on" : ""}" data-act="ed">1re édition</button>
      <button class="chip" data-act="plus">+1 exemplaire</button>
      <button class="chip" data-act="undo">Annuler</button>
      <a class="chip" href="${cmLink(it)}" target="_blank" rel="noopener">Cardmarket ↗</a>
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
  $("totals").textContent = `${total} carte${total > 1 ? "s" : ""}` + (priced ? ` · cote ≈ ${eur(value)}${priced < total ? ` (sur ${priced})` : ""}` : "");
  const todo = items.filter((x) => !x.rarity).length;
  $("exportNote").textContent = todo ? `${todo} ligne${todo > 1 ? "s" : ""} sans rareté : elles ne seront pas exportées tant que tu ne l'as pas choisie.` : "";
  const shown = filter === "todo" ? items.filter((x) => !x.rarity) : items;
  $("empty").hidden = items.length > 0;
  $("list").innerHTML = shown.map((it) => {
    const p = priceText(cmPrice(it.cm));
    return `<div class="item ${it.rarity ? "" : "todo"}" data-id="${it.id}">
      <div class="row1" style="display:flex;justify-content:space-between;gap:8px"><span class="name">${esc(it.nameFR)}</span><span class="price">${esc(p)}</span></div>
      <div class="sub"><span class="code">${esc(it.code)}</span> · ${esc(it.set)} · <a href="${cmLink(it)}" target="_blank" rel="noopener" style="color:inherit">Cardmarket ↗</a></div>
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
  const name = `cardmarket-scan-${new Date().toISOString().slice(0, 10)}.csv`;
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
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); $("clearBtn").textContent = "Confirmer : tout effacer ?"; setTimeout(() => ($("clearBtn").textContent = "Vider la liste"), 4000); return; }
  clearArmed = 0; items = []; lastAdded = null; saveItems(); renderLast(); $("clearBtn").textContent = "Vider la liste"; toast("Liste vidée");
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
bindSettings(); renderList(); renderLast(); loadData();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
window.__cs = { // debug helpers
  matchAll, matchManual, buildCsv, ocr, prep, get DATA() { return DATA; },
  async testStream(s) { stream = s; video.srcObject = s; await video.play(); await getWorker(); scanning = wantScan = true; reads = []; changed = true; loop(); },
};
