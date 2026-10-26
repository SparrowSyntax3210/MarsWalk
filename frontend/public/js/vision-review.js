"use strict";

const MARS_RADIUS_M = 3396190.0;
const TRANSFORM = { a: 20.162955124498982, c: 4577133.445008798, e: -20.162955124498982, f: 1146178.5021103406 };
const LABELS = {
  loose_sand: { name: "Loose sand / possible dune", color: "#edc643" },
  rock_field: { name: "Dense rocks / blocky ground", color: "#ed7950" },
  crater_rim: { name: "Crater rim / steep break", color: "#e85250" },
  other_hazard: { name: "Other visible hazard", color: "#c078f4" },
  visually_clear: { name: "Visually clear surface", color: "#35d2a2" },
  uncertain: { name: "Uncertain / cannot tell", color: "#c5c5c5" },
};

const frame = document.querySelector("#canvas-frame");
const canvas = document.querySelector("#review-canvas");
const ctx = canvas.getContext("2d");
const image = new Image();
const hint = document.querySelector("#canvas-hint");
const coordsReadout = document.querySelector("#canvas-coordinates");
const labelSelect = document.querySelector("#label-select");
const drawButton = document.querySelector("#draw-button");
const finishButton = document.querySelector("#finish-button");
const undoButton = document.querySelector("#undo-button");
const saveButton = document.querySelector("#save-button");
const saveState = document.querySelector("#save-state");
const annotationList = document.querySelector("#annotation-list");
const annotationCount = document.querySelector("#annotation-count");
const noteInput = document.querySelector("#note-input");
const zoomReadout = document.querySelector("#zoom-readout");
const state = {
  features: [],
  draft: [],
  pointer: null,
  drawing: false,
  panning: false,
  spaceDown: false,
  lastPointer: null,
  zoom: 1,
  minZoom: 0.05,
  offsetX: 0,
  offsetY: 0,
  dpr: 1,
  dirty: false,
};

function setSaveState(message, kind) {
  saveState.textContent = message;
  saveState.className = "save-state" + (kind ? " " + kind : "");
}
function markDirty() {
  state.dirty = true;
  setSaveState("Unsaved changes", "");
}
function labelInfo(label) {
  return LABELS[label] || LABELS.uncertain;
}
function lonLatToPixel(position) {
  const lon = Number(position[0]);
  const lat = Number(position[1]);
  const x = MARS_RADIUS_M * lon * Math.PI / 180;
  const y = MARS_RADIUS_M * lat * Math.PI / 180;
  return [(x - TRANSFORM.c) / TRANSFORM.a, (y - TRANSFORM.f) / TRANSFORM.e];
}
function pixelToLonLat(point) {
  const x = TRANSFORM.c + point[0] * TRANSFORM.a;
  const y = TRANSFORM.f + point[1] * TRANSFORM.e;
  return [x / MARS_RADIUS_M * 180 / Math.PI, y / MARS_RADIUS_M * 180 / Math.PI];
}
function featurePixelRings(feature) {
  if (!feature.geometry || feature.geometry.type !== "Polygon") return [];
  return feature.geometry.coordinates.map((ring) => ring.map(lonLatToPixel));
}
function resizeCanvas() {
  const rect = frame.getBoundingClientRect();
  state.dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * state.dpr));
  canvas.height = Math.max(1, Math.round(rect.height * state.dpr));
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  if (image.complete && image.naturalWidth) draw();
}
function fitImage() {
  if (!image.naturalWidth) return;
  const rect = frame.getBoundingClientRect();
  state.zoom = Math.min((rect.width - 24) / image.naturalWidth, (rect.height - 24) / image.naturalHeight);
  state.zoom = Math.max(0.001, state.zoom);
  state.minZoom = state.zoom * 0.35;
  state.offsetX = (rect.width - image.naturalWidth * state.zoom) / 2;
  state.offsetY = (rect.height - image.naturalHeight * state.zoom) / 2;
  updateZoom();
  draw();
}
function updateZoom() {
  zoomReadout.textContent = Math.round(state.zoom / Math.max(state.minZoom, 0.0001) * 100) + "%";
}
function drawFeature(feature, alpha) {
  const rings = featurePixelRings(feature);
  if (!rings.length) return;
  const color = labelInfo(feature.properties && feature.properties.label).color;
  ctx.beginPath();
  for (const ring of rings) {
    ring.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha;
  ctx.fill("evenodd");
  ctx.globalAlpha = Math.min(0.95, alpha + 0.3);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(2.0 / state.zoom, 1.3);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
function draw() {
  const rect = frame.getBoundingClientRect();
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!image.complete || !image.naturalWidth) return;
  ctx.translate(state.offsetX, state.offsetY);
  ctx.scale(state.zoom, state.zoom);
  ctx.drawImage(image, 0, 0);
  for (const feature of state.features) drawFeature(feature, 0.24);
  if (state.draft.length) {
    const color = labelInfo(labelSelect.value).color;
    ctx.beginPath();
    state.draft.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    if (state.pointer) ctx.lineTo(state.pointer[0], state.pointer[1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2.5 / state.zoom, 1.5);
    ctx.setLineDash([7 / state.zoom, 4 / state.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const point of state.draft) {
      ctx.beginPath();
      ctx.arc(point[0], point[1], 3.5 / state.zoom, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  updateZoom();
}
function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}
function pointerImagePosition(event) {
  const p = pointerPosition(event);
  return [(p[0] - state.offsetX) / state.zoom, (p[1] - state.offsetY) / state.zoom];
}
function setDrawing(active) {
  state.drawing = active;
  frame.classList.toggle("drawing", active);
  drawButton.textContent = active ? "Cancel polygon" : "Draw polygon";
  finishButton.disabled = !active || state.draft.length < 3;
  undoButton.disabled = !active || state.draft.length === 0;
  setSaveState(active ? "Drawing polygon…" : (state.dirty ? "Unsaved changes" : "Saved locally"), active ? "" : "saved");
  draw();
}
function finishPolygon() {
  if (state.draft.length > 2) {
    const end = state.draft[state.draft.length - 1];
    const first = state.draft[0];
    if (Math.hypot(end[0] - first[0], end[1] - first[1]) < 3) state.draft.pop();
  }
  if (state.draft.length < 3) {
    setSaveState("A polygon needs at least 3 points", "error");
    return;
  }
  const ring = state.draft.map(pixelToLonLat);
  ring.push(ring[0].slice());
  state.features.push({
    type: "Feature",
    id: "review-" + Date.now() + "-" + Math.floor(Math.random() * 100000),
    properties: {
      label: labelSelect.value,
      note: noteInput.value.trim(),
      review_source: "visual_review_without_model_overlay",
      annotated_at_utc: new Date().toISOString(),
    },
    geometry: { type: "Polygon", coordinates: [ring] },
  });
  state.draft = [];
  state.pointer = null;
  setDrawing(false);
  markDirty();
  renderList();
}
function cancelPolygon() {
  state.draft = [];
  state.pointer = null;
  setDrawing(false);
}
function renderList() {
  annotationList.replaceChildren();
  annotationCount.textContent = state.features.length + (state.features.length === 1 ? " polygon" : " polygons");
  if (!state.features.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No visual labels yet. Add a few clearly identifiable regions to start the review set.";
    annotationList.appendChild(p);
    draw();
    return;
  }
  state.features.forEach((feature, index) => {
    const row = document.createElement("div");
    row.className = "annotation-row";
    const dot = document.createElement("i");
    dot.style.backgroundColor = labelInfo(feature.properties.label).color;
    const title = document.createElement("span");
    title.textContent = (index + 1) + ". " + labelInfo(feature.properties.label).name +
      (feature.properties.note ? " — " + feature.properties.note : "");
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", "Remove annotation " + (index + 1));
    remove.addEventListener("click", () => {
      state.features.splice(index, 1);
      markDirty();
      renderList();
    });
    row.append(dot, title, remove);
    annotationList.appendChild(row);
  });
  draw();
}
function collection() {
  return {
    type: "FeatureCollection",
    metadata: {
      region: "Jezero crater local CTX stereo footprint",
      image: "CTX orthomosaic aligned to approximately 20 m CTX DTM",
      review_method: "visual polygon annotations created without model prediction or weak-label overlay",
      created_at_utc: new Date().toISOString(),
      label_schema: LABELS,
      coordinate_order: "longitude_east_deg, latitude_deg",
    },
    features: state.features,
  };
}
async function saveLabels() {
  saveButton.disabled = true;
  setSaveState("Saving locally…", "");
  try {
    const response = await fetch("/api/vision-review/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collection()),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Save failed");
    state.dirty = false;
    setSaveState("Saved " + result.saved_features + " polygons locally", "saved");
  } catch (error) {
    setSaveState("Could not save: " + error.message, "error");
  } finally {
    saveButton.disabled = false;
  }
}
function exportGeoJSON() {
  const blob = new Blob([JSON.stringify(collection(), null, 2)], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "jezero_visual_review.geojson";
  anchor.click();
  URL.revokeObjectURL(url);
}
async function loadLabels() {
  try {
    const response = await fetch("/api/vision-review/labels");
    if (!response.ok) throw new Error("Review endpoint unavailable");
    const data = await response.json();
    state.features = Array.isArray(data.features) ? data.features : [];
    state.dirty = false;
    setSaveState("Loaded " + state.features.length + " saved polygons", "saved");
    renderList();
  } catch (error) {
    setSaveState("Local save endpoint unavailable", "error");
  }
}
async function loadRouteSummary() {
  const summary = document.querySelector("#route-summary");
  try {
    const response = await fetch("./data/vision-review/route_comparison_ctx.json");
    const report = await response.json();
    const run = report.runs.find((item) => item.vision_weight === 0.15);
    if (!run) throw new Error("No 0.15 vision run in report");
    const shift = run.path_shift_vs_baseline_m;
    summary.textContent = "UI weight 0.15: route length " + run.metrics.distance_km +
      " km; mean path shift " + shift.mean + " m, maximum " + shift.max + " m. This is route sensitivity, not proof of safer traversal.";
  } catch (_error) {
    summary.textContent = "The route comparison image is shown above; route details are unavailable.";
  }
}
canvas.addEventListener("pointerdown", (event) => {
  if (!image.naturalWidth) return;
  if (state.spaceDown || event.button === 1 || (!state.drawing && event.button === 0)) {
    state.panning = true;
    state.lastPointer = pointerPosition(event);
    frame.classList.add("panning");
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (state.drawing && event.button === 0) {
    state.draft.push(pointerImagePosition(event));
    state.pointer = null;
    finishButton.disabled = state.draft.length < 3;
    undoButton.disabled = false;
    draw();
    event.preventDefault();
  }
});
canvas.addEventListener("pointermove", (event) => {
  const imagePoint = pointerImagePosition(event);
  if (image.naturalWidth && imagePoint[0] >= 0 && imagePoint[1] >= 0 &&
      imagePoint[0] <= image.naturalWidth && imagePoint[1] <= image.naturalHeight) {
    const lonlat = pixelToLonLat(imagePoint);
    coordsReadout.textContent = lonlat[1].toFixed(5) + "° lat, " + lonlat[0].toFixed(5) + "° lon";
  } else coordsReadout.textContent = "Move over the image to read coordinates";
  if (state.panning && state.lastPointer) {
    const now = pointerPosition(event);
    state.offsetX += now[0] - state.lastPointer[0];
    state.offsetY += now[1] - state.lastPointer[1];
    state.lastPointer = now;
    draw();
  } else if (state.drawing) {
    state.pointer = imagePoint;
    draw();
  }
});
function endPan() {
  state.panning = false;
  state.lastPointer = null;
  frame.classList.remove("panning");
}
canvas.addEventListener("pointerup", endPan);
canvas.addEventListener("pointercancel", endPan);
canvas.addEventListener("dblclick", (event) => {
  if (!state.drawing) return;
  event.preventDefault();
  finishPolygon();
});
canvas.addEventListener("wheel", (event) => {
  if (!image.naturalWidth) return;
  event.preventDefault();
  const p = pointerPosition(event);
  const before = [(p[0] - state.offsetX) / state.zoom, (p[1] - state.offsetY) / state.zoom];
  const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
  const next = Math.max(state.minZoom, Math.min(4, state.zoom * factor));
  state.zoom = next;
  state.offsetX = p[0] - before[0] * next;
  state.offsetY = p[1] - before[1] * next;
  draw();
}, { passive: false });
window.addEventListener("keydown", (event) => {
  if (event.code === "Space") { state.spaceDown = true; event.preventDefault(); }
  if (event.key === "Escape" && state.drawing) cancelPolygon();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && state.drawing) {
    state.draft.pop(); finishButton.disabled = state.draft.length < 3; undoButton.disabled = !state.draft.length; draw();
  }
});
window.addEventListener("keyup", (event) => { if (event.code === "Space") state.spaceDown = false; });
window.addEventListener("blur", () => { state.spaceDown = false; endPan(); });
drawButton.addEventListener("click", () => state.drawing ? cancelPolygon() : setDrawing(true));
finishButton.addEventListener("click", finishPolygon);
undoButton.addEventListener("click", () => {
  state.draft.pop(); finishButton.disabled = state.draft.length < 3; undoButton.disabled = !state.draft.length; draw();
});
document.querySelector("#zoom-in").addEventListener("click", () => {
  const rect = frame.getBoundingClientRect(); const p = [rect.width / 2, rect.height / 2];
  const before = [(p[0] - state.offsetX) / state.zoom, (p[1] - state.offsetY) / state.zoom];
  state.zoom = Math.min(4, state.zoom * 1.25); state.offsetX = p[0] - before[0] * state.zoom; state.offsetY = p[1] - before[1] * state.zoom; draw();
});
document.querySelector("#zoom-out").addEventListener("click", () => {
  const rect = frame.getBoundingClientRect(); const p = [rect.width / 2, rect.height / 2];
  const before = [(p[0] - state.offsetX) / state.zoom, (p[1] - state.offsetY) / state.zoom];
  state.zoom = Math.max(state.minZoom, state.zoom / 1.25); state.offsetX = p[0] - before[0] * state.zoom; state.offsetY = p[1] - before[1] * state.zoom; draw();
});
document.querySelector("#fit-button").addEventListener("click", fitImage);
saveButton.addEventListener("click", saveLabels);
document.querySelector("#export-button").addEventListener("click", exportGeoJSON);
document.querySelector("#clear-all").addEventListener("click", () => {
  if (!state.features.length || !window.confirm("Remove all visual-review polygons?")) return;
  state.features = []; markDirty(); renderList();
});
labelSelect.addEventListener("change", draw);
image.onload = () => {
  hint.hidden = true;
  resizeCanvas();
  fitImage();
  setSaveState("Loading saved labels…", "");
};
image.onerror = () => { hint.textContent = "Could not load the local Jezero CTX preview image."; };
image.src = "./data/vision-review/jezero_ctx_warm.jpg";
new ResizeObserver(resizeCanvas).observe(frame);
loadLabels();
loadRouteSummary();