/* Kris Photo Edit — a personal Lightroom-style editor.
   Catalog persists in IndexedDB; edits are non-destructive (settings per photo). */
"use strict";

/* ============================== state ============================== */

const DEFAULTS = {
  temp: 0, tint: 0,
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  vibrance: 0, saturation: 0,
  sharpen: 0, vignette: 0,
  rotate: 0,
};

const SLIDER_SECTIONS = [
  { name: "White Balance", items: [
    { k: "temp", label: "Temp", min: -100, max: 100 },
    { k: "tint", label: "Tint", min: -100, max: 100 },
  ]},
  { name: "Tone", items: [
    { k: "exposure", label: "Exposure", min: -500, max: 500, fmt: v => (v / 100).toFixed(2) },
    { k: "contrast", label: "Contrast", min: -100, max: 100 },
    { k: "highlights", label: "Highlights", min: -100, max: 100 },
    { k: "shadows", label: "Shadows", min: -100, max: 100 },
    { k: "whites", label: "Whites", min: -100, max: 100 },
    { k: "blacks", label: "Blacks", min: -100, max: 100 },
  ]},
  { name: "Presence", items: [
    { k: "vibrance", label: "Vibrance", min: -100, max: 100 },
    { k: "saturation", label: "Saturation", min: -100, max: 100 },
  ]},
  { name: "Detail", items: [
    { k: "sharpen", label: "Sharpening", min: 0, max: 100 },
  ]},
  { name: "Effects", items: [
    { k: "vignette", label: "Vignette", min: -100, max: 100 },
  ]},
];

const PRESETS = [
  { name: "Punch", s: { contrast: 25, vibrance: 30, blacks: -10, whites: 10, sharpen: 25 } },
  { name: "Warm Golden", s: { temp: 28, tint: 6, exposure: 15, vibrance: 18 } },
  { name: "Cool Blue", s: { temp: -28, contrast: 12, vibrance: 10 } },
  { name: "B&W Classic", s: { saturation: -100, contrast: 22, sharpen: 20 } },
  { name: "Matte Fade", s: { blacks: 30, contrast: -15, saturation: -15, vignette: -18 } },
  { name: "High Key", s: { exposure: 60, shadows: 40, contrast: -10 } },
];

const state = {
  photos: [],          // {id, name, type, blob, thumb, rating, flag, settings, created}
  currentId: null,
  module: "library",   // 'library' | 'develop'
  filter: { minRating: 0, flag: "all" },
  clipboard: null,
  beforeMode: false,
};

/* ============================== IndexedDB ============================== */

const DB_NAME = "krisPhotoEdit", STORE = "photos";
let _db = null;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function db() { return _db || (_db = await openDB()); }
async function dbPut(rec) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbAll() {
  const d = await db();
  return new Promise((res, rej) => {
    const rq = d.transaction(STORE).objectStore(STORE).getAll();
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
async function dbDelete(id) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}

const savePhoto = debounce(p => dbPut(p).catch(console.error), 400);

/* ============================== WebGL renderer ============================== */

const VERT = `
attribute vec2 a_pos;
attribute vec2 a_tex;
varying vec2 v_tex;
void main() {
  v_tex = a_tex;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 v_tex;
uniform sampler2D u_image;
uniform vec2 u_texSize;
uniform float u_exposure, u_contrast, u_highlights, u_shadows, u_whites, u_blacks;
uniform float u_temp, u_tint, u_vibrance, u_saturation, u_sharpen, u_vignette;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

void main() {
  vec3 c = texture2D(u_image, v_tex).rgb;

  // sharpening (unsharp mask, 4-tap)
  if (u_sharpen > 0.0) {
    vec2 px = 1.0 / u_texSize;
    vec3 blur = texture2D(u_image, v_tex + vec2(px.x, 0.0)).rgb
              + texture2D(u_image, v_tex - vec2(px.x, 0.0)).rgb
              + texture2D(u_image, v_tex + vec2(0.0, px.y)).rgb
              + texture2D(u_image, v_tex - vec2(0.0, px.y)).rgb;
    blur *= 0.25;
    c += (c - blur) * u_sharpen * 1.5;
  }

  // white balance
  c.r *= 1.0 + u_temp * 0.25;
  c.b *= 1.0 - u_temp * 0.25;
  c.g *= 1.0 - u_tint * 0.18;

  // exposure (stops)
  c *= exp2(u_exposure);

  // contrast around mid-gray
  c = (c - 0.5) * (1.0 + u_contrast * 0.8) + 0.5;

  // highlights / shadows / whites / blacks
  float luma = dot(clamp(c, 0.0, 1.0), LUMA);
  float hMask = smoothstep(0.45, 1.0, luma);
  float sMask = 1.0 - smoothstep(0.0, 0.55, luma);
  c += u_highlights * 0.35 * hMask;
  c += u_shadows * 0.35 * sMask;
  c += u_whites * 0.25 * smoothstep(0.55, 1.05, luma);
  c += u_blacks * 0.25 * (1.0 - smoothstep(0.0, 0.35, luma));

  // vibrance (boost muted colors more) then saturation
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx - mn;
  float l2 = dot(c, LUMA);
  c = mix(vec3(l2), c, 1.0 + u_vibrance * (1.0 - clamp(sat, 0.0, 1.0)) * 0.9);
  c = mix(vec3(dot(c, LUMA)), c, 1.0 + u_saturation);

  // vignette
  float d = distance(v_tex, vec2(0.5)) * 1.4142;
  c *= 1.0 + u_vignette * smoothstep(0.35, 1.0, d);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// texcoords for corners [BL, BR, TL, TR] per rotation (0/90/180/270 clockwise)
const TEXCOORDS = {
  0:   [0, 1, 1, 1, 0, 0, 1, 0],
  90:  [1, 1, 1, 0, 0, 1, 0, 0],
  180: [1, 0, 0, 0, 1, 1, 0, 1],
  270: [0, 0, 0, 1, 1, 0, 1, 1],
};

function createRenderer(canvas) {
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
  if (!gl) { alert("WebGL is not supported in this browser."); throw new Error("no webgl"); }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const texBuf = gl.createBuffer();
  const aTex = gl.getAttribLocation(prog, "a_tex");

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const U = {};
  for (const n of ["u_texSize", "u_exposure", "u_contrast", "u_highlights", "u_shadows",
    "u_whites", "u_blacks", "u_temp", "u_tint", "u_vibrance", "u_saturation",
    "u_sharpen", "u_vignette"])
    U[n] = gl.getUniformLocation(prog, n);

  let imgW = 0, imgH = 0;

  return {
    gl,
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    setImage(source, w, h) {
      imgW = w; imgH = h;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    },
    render(settings) {
      const s = settings;
      const rot = s.rotate || 0;
      const outW = (rot === 90 || rot === 270) ? imgH : imgW;
      const outH = (rot === 90 || rot === 270) ? imgW : imgH;
      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW; canvas.height = outH;
      }
      gl.viewport(0, 0, outW, outH);

      gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(TEXCOORDS[rot]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(aTex);
      gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

      gl.uniform2f(U.u_texSize, imgW, imgH);
      gl.uniform1f(U.u_exposure, s.exposure / 100);
      gl.uniform1f(U.u_contrast, s.contrast / 100);
      gl.uniform1f(U.u_highlights, s.highlights / 100);
      gl.uniform1f(U.u_shadows, s.shadows / 100);
      gl.uniform1f(U.u_whites, s.whites / 100);
      gl.uniform1f(U.u_blacks, s.blacks / 100);
      gl.uniform1f(U.u_temp, s.temp / 100);
      gl.uniform1f(U.u_tint, s.tint / 100);
      gl.uniform1f(U.u_vibrance, s.vibrance / 100);
      gl.uniform1f(U.u_saturation, s.saturation / 100);
      gl.uniform1f(U.u_sharpen, s.sharpen / 100);
      gl.uniform1f(U.u_vignette, s.vignette / 100);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}

/* ============================== helpers ============================== */

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function $(id) { return document.getElementById(id); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function currentPhoto() { return state.photos.find(p => p.id === state.currentId) || null; }
function isEdited(p) {
  return Object.keys(DEFAULTS).some(k => (p.settings[k] || 0) !== DEFAULTS[k]);
}
function visiblePhotos() {
  return state.photos.filter(p => {
    if (p.rating < state.filter.minRating) return false;
    if (state.filter.flag === "pick" && p.flag !== "pick") return false;
    if (state.filter.flag === "reject" && p.flag !== "reject") return false;
    return true;
  });
}

async function loadBitmap(blob, maxDim) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  if (!maxDim || Math.max(bmp.width, bmp.height) <= maxDim) return bmp;
  const scale = maxDim / Math.max(bmp.width, bmp.height);
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return c;
}

async function makeThumb(blob) {
  const bmp = await loadBitmap(blob, 360);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  c.getContext("2d").drawImage(bmp, 0, 0);
  return c.toDataURL("image/jpeg", 0.72);
}

/* ============================== import ============================== */

async function importFiles(files) {
  const images = [...files].filter(f => f.type.startsWith("image/"));
  if (!images.length) return;
  for (const f of images) {
    try {
      const rec = {
        id: uid(), name: f.name, type: f.type, blob: f,
        thumb: await makeThumb(f),
        rating: 0, flag: "", settings: { ...DEFAULTS }, created: Date.now(),
      };
      state.photos.push(rec);
      await dbPut(rec);
    } catch (e) {
      console.error("Failed to import", f.name, e);
    }
  }
  if (!state.currentId && state.photos.length) state.currentId = state.photos[0].id;
  renderAll();
}

/* ============================== develop editor ============================== */

let renderer = null;
let loadedForId = null;

async function ensureEditorImage() {
  const p = currentPhoto();
  if (!p || loadedForId === p.id) return;
  const bmp = await loadBitmap(p.blob, Math.min(2200, renderer.maxTex));
  renderer.setImage(bmp, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  loadedForId = p.id;
}

const updateHistogramSoon = debounce(updateHistogram, 120);

async function renderDevelop() {
  const p = currentPhoto();
  if (!p || state.module !== "develop") return;
  await ensureEditorImage();
  renderer.render(state.beforeMode ? { ...DEFAULTS, rotate: p.settings.rotate } : p.settings);
  updateHistogramSoon();
}

function updateHistogram() {
  const src = $("dev-canvas");
  if (!src.width) return;
  const w = 128, h = 80;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const bins = 64, R = new Float32Array(bins), G = new Float32Array(bins), B = new Float32Array(bins);
  for (let i = 0; i < data.length; i += 4) {
    R[data[i] >> 2]++; G[data[i + 1] >> 2]++; B[data[i + 2] >> 2]++;
  }
  const hist = $("histogram"), hc = hist.getContext("2d");
  const W = hist.width, H = hist.height;
  hc.clearRect(0, 0, W, H);
  hc.fillStyle = "#1a1a1a"; hc.fillRect(0, 0, W, H);
  const max = Math.max(1, ...R, ...G, ...B);
  hc.globalCompositeOperation = "screen";
  for (const [arr, color] of [[R, "#b04040"], [G, "#40a040"], [B, "#4060c0"]]) {
    hc.fillStyle = color;
    hc.beginPath();
    hc.moveTo(0, H);
    for (let i = 0; i < bins; i++)
      hc.lineTo((i / (bins - 1)) * W, H - Math.sqrt(arr[i] / max) * H);
    hc.lineTo(W, H);
    hc.closePath();
    hc.fill();
  }
  hc.globalCompositeOperation = "source-over";
}

function setSetting(key, value) {
  const p = currentPhoto();
  if (!p) return;
  p.settings[key] = value;
  savePhoto(p);
  renderDevelop();
  refreshEditedBadges();
}

function applySettings(partial) {
  const p = currentPhoto();
  if (!p) return;
  p.settings = { ...DEFAULTS, rotate: p.settings.rotate, ...partial };
  savePhoto(p);
  syncSliders();
  renderDevelop();
  refreshEditedBadges();
}

function rotateBy(deg) {
  const p = currentPhoto();
  if (!p) return;
  p.settings.rotate = ((p.settings.rotate || 0) + deg + 360) % 360;
  savePhoto(p);
  renderDevelop();
}

/* ============================== export ============================== */

async function exportCurrent() {
  const p = currentPhoto();
  if (!p) return;
  const btn = $("export-btn");
  btn.textContent = "Exporting…"; btn.disabled = true;
  try {
    const quality = +$("export-quality").value / 100;
    const longEdge = +$("export-size").value;
    const maxDim = Math.min(longEdge || renderer.maxTex, renderer.maxTex);
    const bmp = await loadBitmap(p.blob, maxDim);
    renderer.setImage(bmp, bmp.width, bmp.height);
    renderer.render(p.settings);
    const canvas = $("dev-canvas");
    const blob = await new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = p.name.replace(/\.[^.]+$/, "") + "_edited.jpg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    btn.textContent = "Export JPEG"; btn.disabled = false;
    loadedForId = null;          // editor texture was replaced; reload working-size image
    renderDevelop();
  }
}

/* ============================== UI rendering ============================== */

function starsHTML(rating) {
  let s = "";
  for (let i = 1; i <= 5; i++)
    s += `<span class="star ${i <= rating ? "on" : ""}" data-star="${i}">★</span>`;
  return s;
}
function flagIcon(flag) {
  return flag === "pick" ? `<span class="gi-flag pick">⚑</span>`
       : flag === "reject" ? `<span class="gi-flag reject">✕</span>` : "";
}

function renderGrid() {
  const grid = $("grid");
  const photos = visiblePhotos();
  $("empty-state").style.display = state.photos.length ? "none" : "flex";
  grid.innerHTML = photos.map(p => `
    <div class="grid-item ${p.id === state.currentId ? "selected" : ""} ${isEdited(p) ? "edited" : ""}" data-id="${p.id}">
      <button class="gi-del" title="Remove from catalog">✕</button>
      <img src="${p.thumb}" alt="">
      <div class="gi-name">${p.name}</div>
      <div class="gi-meta">
        <div class="stars">${starsHTML(p.rating)}</div>
        ${flagIcon(p.flag)}
      </div>
    </div>`).join("");
}

function renderFilmstrip() {
  $("filmstrip").innerHTML = visiblePhotos().map(p => `
    <div class="fs-item ${p.id === state.currentId ? "selected" : ""}" data-id="${p.id}">
      <img src="${p.thumb}" alt="">${flagIcon(p.flag)}
    </div>`).join("");
  const sel = document.querySelector("#filmstrip .selected");
  if (sel) sel.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderCounts() {
  $("all-count").textContent = state.photos.length;
  $("photo-count").textContent = state.photos.length ? `${state.photos.length} photos` : "";
}

function refreshEditedBadges() {
  if (state.module === "library") renderGrid();
}

function syncSliders() {
  const p = currentPhoto();
  const s = p ? p.settings : DEFAULTS;
  document.querySelectorAll("#sliders input[type=range]").forEach(inp => {
    const k = inp.dataset.key;
    inp.value = s[k] ?? 0;
    inp.closest(".slider-row").querySelector(".val").textContent =
      inp._fmt ? inp._fmt(+inp.value) : inp.value;
  });
  $("dev-stars").innerHTML = starsHTML(p ? p.rating : 0);
  document.querySelectorAll("#dev-flags button").forEach(b =>
    b.classList.toggle("active", p && p.flag === b.dataset.flag));
  $("dev-filename").textContent = p ? p.name : "";
}

function setModule(mod) {
  if (mod === "develop" && !currentPhoto()) {
    if (!state.photos.length) return;
    state.currentId = visiblePhotos()[0]?.id || state.photos[0].id;
  }
  state.module = mod;
  $("nav-library").classList.toggle("active", mod === "library");
  $("nav-develop").classList.toggle("active", mod === "develop");
  $("library-view").hidden = mod !== "library";
  $("develop-view").hidden = mod !== "develop";
  $("right-panel").hidden = mod !== "develop";
  $("presets-section").style.display = mod === "develop" ? "" : "none";
  renderAll();
  if (mod === "develop") { syncSliders(); renderDevelop(); }
}

function selectPhoto(id) {
  state.currentId = id;
  renderGrid();
  renderFilmstrip();
  if (state.module === "develop") { syncSliders(); renderDevelop(); }
}

function navigate(delta) {
  const list = visiblePhotos();
  if (!list.length) return;
  const idx = Math.max(0, list.findIndex(p => p.id === state.currentId));
  const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))];
  if (next) selectPhoto(next.id);
}

function setRating(rating) {
  const p = currentPhoto();
  if (!p) return;
  p.rating = rating;
  savePhoto(p);
  renderGrid(); renderFilmstrip(); syncSliders();
}

function setFlag(flag) {
  const p = currentPhoto();
  if (!p) return;
  p.flag = p.flag === flag ? "" : flag;
  savePhoto(p);
  renderGrid(); renderFilmstrip(); syncSliders();
}

async function deletePhoto(id) {
  const p = state.photos.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Remove "${p.name}" from the catalog?`)) return;
  await dbDelete(id);
  state.photos = state.photos.filter(x => x.id !== id);
  if (state.currentId === id) {
    state.currentId = state.photos[0]?.id || null;
    loadedForId = null;
  }
  if (!state.photos.length && state.module === "develop") setModule("library");
  renderAll();
}

function renderAll() {
  renderCounts();
  renderGrid();
  renderFilmstrip();
}

/* ============================== UI building & events ============================== */

function buildSliders() {
  const root = $("sliders");
  root.innerHTML = "";
  for (const sec of SLIDER_SECTIONS) {
    const div = document.createElement("div");
    div.className = "panel-section";
    div.innerHTML = `<h3>${sec.name}</h3>`;
    for (const it of sec.items) {
      const row = document.createElement("div");
      row.className = "slider-row";
      row.innerHTML = `<label>${it.label}</label>
        <input type="range" min="${it.min}" max="${it.max}" value="0" data-key="${it.k}">
        <span class="val">0</span>`;
      const inp = row.querySelector("input");
      inp._fmt = it.fmt;
      inp.addEventListener("input", () => {
        row.querySelector(".val").textContent = it.fmt ? it.fmt(+inp.value) : inp.value;
        setSetting(it.k, +inp.value);
      });
      inp.addEventListener("dblclick", () => {
        inp.value = 0;
        row.querySelector(".val").textContent = it.fmt ? it.fmt(0) : "0";
        setSetting(it.k, 0);
      });
      div.appendChild(row);
    }
    root.appendChild(div);
  }
}

function buildPresets() {
  $("preset-list").innerHTML = PRESETS.map((p, i) =>
    `<div class="preset" data-i="${i}">${p.name}</div>`).join("");
  $("preset-list").addEventListener("click", e => {
    const el = e.target.closest(".preset");
    if (el) applySettings(PRESETS[+el.dataset.i].s);
  });
}

function buildFilterStars() {
  const el = $("filter-stars");
  el.innerHTML = starsHTML(state.filter.minRating);
  el.addEventListener("click", e => {
    const st = e.target.closest(".star");
    if (!st) return;
    const n = +st.dataset.star;
    state.filter.minRating = state.filter.minRating === n ? 0 : n;
    el.innerHTML = starsHTML(state.filter.minRating);
    renderAll();
  });
}

function wireEvents() {
  $("nav-library").onclick = () => setModule("library");
  $("nav-develop").onclick = () => setModule("develop");
  $("import-btn").onclick = () => $("file-input").click();
  $("file-input").addEventListener("change", e => {
    importFiles(e.target.files);
    e.target.value = "";
  });

  // drag & drop import
  let dragDepth = 0;
  window.addEventListener("dragenter", e => {
    e.preventDefault();
    if (++dragDepth === 1) $("drop-overlay").hidden = false;
  });
  window.addEventListener("dragleave", e => {
    e.preventDefault();
    if (--dragDepth <= 0) { dragDepth = 0; $("drop-overlay").hidden = true; }
  });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault();
    dragDepth = 0; $("drop-overlay").hidden = true;
    importFiles(e.dataTransfer.files);
  });

  // library grid
  $("grid").addEventListener("click", e => {
    const item = e.target.closest(".grid-item");
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest(".gi-del")) { deletePhoto(id); return; }
    const star = e.target.closest(".star");
    if (star) { state.currentId = id; setRating(+star.dataset.star === currentPhoto().rating ? 0 : +star.dataset.star); return; }
    selectPhoto(id);
  });
  $("grid").addEventListener("dblclick", e => {
    const item = e.target.closest(".grid-item");
    if (item) { selectPhoto(item.dataset.id); setModule("develop"); }
  });

  // filmstrip
  $("filmstrip").addEventListener("click", e => {
    const item = e.target.closest(".fs-item");
    if (item) selectPhoto(item.dataset.id);
  });

  // flag filter
  $("filter-flags").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    state.filter.flag = b.dataset.flag;
    document.querySelectorAll("#filter-flags button").forEach(x =>
      x.classList.toggle("active", x === b));
    renderAll();
  });

  // develop tools
  $("rotate-ccw").onclick = () => rotateBy(-90);
  $("rotate-cw").onclick = () => rotateBy(90);
  const ba = $("before-after");
  const beforeOn = () => { state.beforeMode = true; ba.classList.add("active"); renderDevelop(); };
  const beforeOff = () => { state.beforeMode = false; ba.classList.remove("active"); renderDevelop(); };
  ba.addEventListener("mousedown", beforeOn);
  window.addEventListener("mouseup", () => state.beforeMode && beforeOff());

  // rating / flags in develop panel
  $("dev-stars").addEventListener("click", e => {
    const st = e.target.closest(".star");
    if (!st) return;
    const n = +st.dataset.star;
    setRating(currentPhoto() && currentPhoto().rating === n ? 0 : n);
  });
  $("dev-flags").addEventListener("click", e => {
    const b = e.target.closest("button");
    if (b) setFlag(b.dataset.flag);
  });

  // copy / paste / reset
  $("copy-btn").onclick = () => {
    const p = currentPhoto();
    if (p) state.clipboard = { ...p.settings };
  };
  $("paste-btn").onclick = () => {
    if (state.clipboard) applySettings(state.clipboard);
  };
  $("reset-btn").onclick = () => applySettings({});

  // export
  $("export-quality").addEventListener("input", e =>
    $("export-quality-val").textContent = e.target.value);
  $("export-btn").onclick = () => exportCurrent().catch(err => {
    console.error(err);
    alert("Export failed: " + err.message);
  });

  // keyboard
  window.addEventListener("keydown", e => {
    if (e.target instanceof Element && e.target.matches("input, select, textarea")) return;
    const k = e.key;
    if (k === "g" || k === "G") setModule("library");
    else if (k === "d" || k === "D") setModule("develop");
    else if (k === "ArrowRight") navigate(1);
    else if (k === "ArrowLeft") navigate(-1);
    else if (k >= "0" && k <= "5") setRating(+k);
    else if (k === "p" || k === "P") setFlag("pick");
    else if (k === "x" || k === "X") setFlag("reject");
    else if (k === "u" || k === "U") { const p = currentPhoto(); if (p) { p.flag = ""; savePhoto(p); renderAll(); syncSliders(); } }
    else if (k === "Delete" || k === "Backspace") { if (state.currentId) deletePhoto(state.currentId); }
    else if (k === "\\") {
      if (!state.beforeMode) { state.beforeMode = true; $("before-after").classList.add("active"); renderDevelop(); }
    } else return;
    e.preventDefault();
  });
  window.addEventListener("keyup", e => {
    if (e.key === "\\" && state.beforeMode) {
      state.beforeMode = false;
      $("before-after").classList.remove("active");
      renderDevelop();
    }
  });
}

/* ============================== init ============================== */

async function init() {
  renderer = createRenderer($("dev-canvas"));
  buildSliders();
  buildPresets();
  buildFilterStars();
  wireEvents();
  try {
    const recs = await dbAll();
    recs.sort((a, b) => a.created - b.created);
    state.photos = recs.map(r => ({ ...r, settings: { ...DEFAULTS, ...r.settings } }));
    if (state.photos.length) state.currentId = state.photos[0].id;
  } catch (e) {
    console.error("Failed to load catalog", e);
  }
  renderAll();
}

init();

// exposed for debugging / testing
window.app = { state, importFiles, setModule, selectPhoto, setSetting, applySettings };
