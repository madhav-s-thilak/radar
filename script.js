// ─────────────────────────────────────────────────────────────────────────────
// Antarctica Meltwater Detection — CesiumJS Visualisation  v4
//
// FIX 1: Math.min/max spread crash on large arrays → use reduce()
// FIX 2: Coloring now uses consensus_meltwater flag as primary truth signal.
//         melt_prob is used only for intensity within confirmed detections.
//         Non-meltwater traces render as dim blue, not orange/red.
// NEW:    Color mode toggle — "Consensus" (scientific) vs "Probability" (raw)
// ─────────────────────────────────────────────────────────────────────────────

Cesium.Ion.defaultAccessToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJiYjg2ZjQ0ZC02YWNhLTQyNGYtYjAyYS01YzY1MzgxNTk0OTEiLCJpZCI6NDAxMjI5LCJpYXQiOjE3NzMxMzMyMzF9.5Hwu9ciIqd3qfmaYCdTykSNO3Osnq-k1x0gVhOoZ2iI";

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation:            false,
  timeline:             false,
  baseLayerPicker:      false,
  geocoder:             false,
  homeButton:           false,
  sceneModePicker:      false,
  navigationHelpButton: false,
  fullscreenButton:     false,
  infoBox:              false,
  selectionIndicator:   false,
  terrain: Cesium.Terrain.fromWorldTerrain(),
});

const scene  = viewer.scene;
const camera = viewer.camera;

// ── Colour helpers ────────────────────────────────────────────────────────────

// Meltwater gradient: amber → orange → red  (only used for confirmed melt)
const MELT_RAMP = [
  [0.0,  [255, 220,  50]],   // amber  (low confidence meltwater)
  [0.5,  [255, 100,   0]],   // orange
  [1.0,  [210,   0,  15]],   // red    (high confidence meltwater)
];

// Ice gradient: dark navy → steel blue (for non-meltwater traces)
const ICE_RAMP = [
  [0.0,  [15,  30,  70]],
  [1.0,  [40,  90, 160]],
];

function interpolateRamp(ramp, t) {
  t = Math.max(0, Math.min(1, t));
  let lo = ramp[0], hi = ramp[ramp.length - 1];
  for (let i = 0; i < ramp.length - 1; i++) {
    if (t >= ramp[i][0] && t <= ramp[i+1][0]) { lo = ramp[i]; hi = ramp[i+1]; break; }
  }
  const f = (t - lo[0]) / (hi[0] - lo[0] + 1e-9);
  return [
    Math.round(lo[1][0] + f * (hi[1][0] - lo[1][0])),
    Math.round(lo[1][1] + f * (hi[1][1] - lo[1][1])),
    Math.round(lo[1][2] + f * (hi[1][2] - lo[1][2])),
  ];
}

// CONSENSUS mode (default, scientifically correct):
//   confirmed meltwater (consensus=1) → amber→red scaled by melt_prob
//   non-meltwater        (consensus=0) → dim blue, small, semi-transparent
//
// PROBABILITY mode (raw GMM output):
//   all traces coloured navy→teal→red by melt_prob regardless of consensus

function colorConsensus(p) {
  if (p.cons === 1) {
    const [r,g,b] = interpolateRamp(MELT_RAMP, p.melt);
    return new Cesium.Color(r/255, g/255, b/255, 0.75 + 0.25 * p.melt);
  } else {
    const [r,g,b] = interpolateRamp(ICE_RAMP, p.melt);
    return new Cesium.Color(r/255, g/255, b/255, 0.25);   // dim
  }
}

const PROB_RAMP = [
  [0.00, [26,  58, 110]],
  [0.20, [30, 111, 168]],
  [0.40, [ 0, 200, 168]],
  [0.60, [245,196,  0]],
  [0.80, [255,106,  0]],
  [1.00, [224,  0, 15]],
];
function colorProbability(p) {
  const [r,g,b] = interpolateRamp(PROB_RAMP, p.melt);
  return new Cesium.Color(r/255, g/255, b/255, 0.55 + 0.45 * p.melt);
}

function pointColor(p) {
  return colorMode === "consensus" ? colorConsensus(p) : colorProbability(p);
}

function pointSize(p) {
  if (colorMode === "consensus") {
    return p.cons === 1 ? 4 + p.melt * 6 : 2;   // meltwater bigger
  }
  return 3 + p.melt * 7;
}

// ── State ─────────────────────────────────────────────────────────────────────
let allPoints       = [];
let pointCollection = null;
let currentView     = "all";
let threshold       = 0.0;
let colorMode       = "consensus";   // "consensus" | "probability"

// ── CSV loader ────────────────────────────────────────────────────────────────
async function loadCSV() {
  setLoadingText("Fetching data.csv …");
  setLoadingProgress(5);

  let text;
  try {
    const res = await fetch("data.csv");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    alert("Could not load data.csv:\n" + e.message +
          "\n\nPlace data.csv in the same folder as index.html.");
    hideLoading(); return;
  }

  setLoadingText("Parsing …");
  setLoadingProgress(15);

  const rows    = text.trim().split(/\r?\n/);
  const headers = rows[0].split(",").map(h => h.trim().toLowerCase());
  const col     = (...names) => {
    for (const n of names) { const i = headers.indexOf(n); if (i !== -1) return i; }
    return -1;
  };

  const latI  = col("latitude");
  const lonI  = col("longitude");
  const elevI = col("elevation");
  const meltI = col("melt_prob");
  const consI = col("consensus_meltwater");
  const fileI = col("filename");
  const gmmI  = col("gmm_label");
  const ppI   = col("peak_power_db");
  const kurtI = col("kurtosis");
  const rsrI  = col("rsr_specularity");

  if ([latI, lonI, meltI].some(i => i === -1)) {
    const missing = [["latitude",latI],["longitude",lonI],["melt_prob",meltI]]
      .filter(([,i]) => i === -1).map(([n]) => n);
    alert("Missing columns: " + missing.join(", ") +
          "\nFound: " + headers.join(", "));
    hideLoading(); return;
  }

  allPoints = [];
  let totalMelt = 0, sumProb = 0;

  for (let i = 1; i < rows.length; i++) {
    if (!rows[i].trim()) continue;
    const c    = rows[i].split(",");
    const lat  = parseFloat(c[latI]);
    const lon  = parseFloat(c[lonI]);
    const melt = parseFloat(c[meltI]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const elevRaw = elevI !== -1 ? parseFloat(c[elevI]) : NaN;
    const cons    = consI !== -1 ? parseInt(c[consI])   : null;
    const prob    = Number.isFinite(melt) ? melt : 0;

    allPoints.push({
      lat, lon,
      elev:     Number.isFinite(elevRaw) ? Math.max(elevRaw, 0) : 0,
      melt:     prob,
      cons:     Number.isFinite(cons) ? cons : null,
      filename: fileI  !== -1 ? (c[fileI]  || "—") : "—",
      gmm:      gmmI   !== -1 ? parseInt(c[gmmI])   : null,
      pp:       ppI    !== -1 ? parseFloat(c[ppI])   : null,
      kurt:     kurtI  !== -1 ? parseFloat(c[kurtI]) : null,
      rsr:      rsrI   !== -1 ? parseFloat(c[rsrI])  : null,
    });

    // Count consensus meltwater for stats (fall back to prob≥0.5 if no flag)
    const isMelt = cons !== null ? cons === 1 : prob >= 0.5;
    if (isMelt) totalMelt++;
    sumProb += prob;

    if (i % 5000 === 0) {
      setLoadingProgress(15 + 45 * (i / rows.length));
      await yieldToUI();
    }
  }

  const N = allPoints.length;
  const hasConsensus = allPoints.some(p => p.cons !== null);

  setText("s-total", N.toLocaleString());
  setText("s-melt",  totalMelt.toLocaleString());
  setText("s-frac",  (100 * totalMelt / Math.max(N,1)).toFixed(2) + "%");
  setText("s-mean",  (sumProb / Math.max(N,1)).toFixed(4));

  // Show / hide consensus-mode button based on data availability
  const btnCons = document.getElementById("btn-mode-cons");
  if (btnCons) btnCons.style.display = hasConsensus ? "" : "none";

  // Default to consensus mode if the column exists
  if (!hasConsensus) colorMode = "probability";
  updateModeButtons();

  setLoadingText("Rendering points …");
  setLoadingProgress(65);
  await buildPointCloud(allPoints);
  setLoadingProgress(100);
  await yieldToUI();
  hideLoading();
  flyToData();
}

// ── Point primitive collection ────────────────────────────────────────────────
async function buildPointCloud(points) {
  if (pointCollection) {
    scene.primitives.remove(pointCollection);
    pointCollection = null;
  }
  pointCollection = scene.primitives.add(new Cesium.PointPrimitiveCollection());

  let drawn = 0;
  for (const p of points) {
    if (currentView === "melt" && !(p.cons === 1 || (p.cons === null && p.melt >= 0.5))) continue;
    if (currentView === "ice"  &&  (p.cons === 1 || (p.cons === null && p.melt >= 0.5))) continue;
    if (p.melt < threshold) continue;

    pointCollection.add({
      position:  Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.elev),
      color:     pointColor(p),
      pixelSize: pointSize(p),
      id: p,
    });

    if (++drawn % 3000 === 0) await yieldToUI();
  }
}

// ── Hover tooltip ─────────────────────────────────────────────────────────────
const tooltip = document.getElementById("tooltip");
const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

handler.setInputAction(movement => {
  const picked = scene.pick(movement.endPosition);
  if (Cesium.defined(picked) &&
      picked.primitive instanceof Cesium.PointPrimitive &&
      picked.primitive.id) {
    const p = picked.primitive.id;
    const fname = (p.filename || "—").split("/").pop().replace(".mat","");
    setText("tt-file", fname);
    setText("tt-melt", p.melt.toFixed(4));
    setText("tt-cons", p.cons !== null
      ? (p.cons === 1 ? "✓  YES" : "✗  No") : "—");
    setText("tt-gmm",  p.gmm  !== null ? `C${p.gmm}` : "—");
    setText("tt-lat",  p.lat.toFixed(5) + "°");
    setText("tt-lon",  p.lon.toFixed(5) + "°");
    setText("tt-elev", Number.isFinite(p.elev) ? Math.round(p.elev) + " m" : "—");
    setText("tt-pp",   p.pp   !== null && isFinite(p.pp)   ? p.pp.toFixed(2)   + " dB" : "—");
    setText("tt-kurt", p.kurt !== null && isFinite(p.kurt) ? p.kurt.toFixed(3)          : "—");
    setText("tt-rsr",  p.rsr  !== null && isFinite(p.rsr)  ? p.rsr.toFixed(2)  + " dB" : "—");
    tooltip.style.display = "block";
  } else {
    tooltip.style.display = "none";
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// ── Controls ──────────────────────────────────────────────────────────────────
window.setView = function(mode) {
  currentView = mode;
  ["all","melt","ice"].forEach(m =>
    document.getElementById(`btn-${m}`).classList.toggle("active", m === mode));
  rebuildPoints();
};

window.setColorMode = function(mode) {
  colorMode = mode;
  updateModeButtons();
  rebuildPoints();
};

function updateModeButtons() {
  const c = document.getElementById("btn-mode-cons");
  const p = document.getElementById("btn-mode-prob");
  if (c) c.classList.toggle("active", colorMode === "consensus");
  if (p) p.classList.toggle("active", colorMode === "probability");
}

document.getElementById("threshold").addEventListener("input", function () {
  threshold = parseFloat(this.value);
  document.getElementById("thresh-val").textContent = threshold.toFixed(2);
  rebuildPoints();
});

async function rebuildPoints() {
  const ld = document.getElementById("loading");
  ld.classList.remove("hidden");
  setLoadingText("Filtering …");
  setLoadingProgress(30);
  await yieldToUI();
  await buildPointCloud(allPoints);
  ld.classList.add("hidden");
}

// ── Camera ────────────────────────────────────────────────────────────────────
window.flyToAntarctica = function() {
  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(0, -90, 4_000_000),
    duration: 2.0,
  });
};

window.flyToData = function() {
  if (!allPoints.length) { flyToAntarctica(); return; }

  // FIX 1: Use reduce() instead of Math.min/max(...array)
  // Spread operator crashes the JS call stack with 300k+ elements
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const p of allPoints) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const midLat = (minLat + maxLat) / 2;
  const midLon = (minLon + maxLon) / 2;
  const span   = Math.max(maxLat - minLat, maxLon - minLon);
  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      midLon, midLat, Math.max(span * 120_000, 400_000)),
    duration: 2.5,
  });
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setLoadingText(t)     { setText("loading-text", t); }
function setLoadingProgress(p) {
  const el = document.getElementById("loading-bar");
  if (el) el.style.width = Math.min(p, 100) + "%";
}
function hideLoading() { document.getElementById("loading").classList.add("hidden"); }
function yieldToUI()   { return new Promise(r => setTimeout(r, 0)); }

// ── Boot ──────────────────────────────────────────────────────────────────────
flyToAntarctica();
loadCSV().catch(err => {
  console.error(err);
  alert("Unexpected error: " + err.message);
  hideLoading();
});