import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const canvas3D = document.querySelector("#mars-scene");
const containerBox = document.querySelector("#mars-3d-box");
const labels3DLayer = document.querySelector("#labels-3d-layer");
const regionListContainer = document.querySelector("#region-list-container");

const regionTitleEl = document.querySelector("#region-title");
const coordReadoutEl = document.querySelector("#coord-readout");
const pointStatusEl = document.querySelector("#point-status");
const pointDataEl = document.querySelector("#point-data");
const pointPanelToggle = document.querySelector("#point-panel-toggle");
const layerSelectEl = document.querySelector("#layer-select");
const zoomLabelEl = document.querySelector("#zoom-label");

const LON_OFFSET = -90;
const GLOBE_RADIUS = 1.275;

// =========================================================================
// 1. MARS REGIONS DATABASE
// =========================================================================
const MARS_REGIONS = [
  {
    name: "Gale Crater",
    fullTitle: "Gale Crater — Curiosity Landing Site",
    lat: -5.4,
    lon: 137.8,
    zoom: 9,
  },
  {
    name: "Jezero Crater",
    fullTitle: "Jezero Crater — Perseverance Delta",
    lat: 18.44,
    lon: 77.45,
    zoom: 10,
  },
  {
    name: "Gusev Crater",
    fullTitle: "Gusev Crater — Spirit Rover Site",
    lat: -14.56,
    lon: 175.47,
    zoom: 9,
  },
  {
    name: "Elysium Planitia",
    fullTitle: "Elysium Planitia — InSight Lander",
    lat: 4.5,
    lon: 135.62,
    zoom: 9,
  },
  {
    name: "Olympus Mons",
    fullTitle: "Olympus Mons — Shield Volcano",
    lat: 18.65,
    lon: -133.8,
    zoom: 7,
  },
  {
    name: "Valles Marineris",
    fullTitle: "Valles Marineris — Candor Chasma",
    lat: -6.5,
    lon: -70.8,
    zoom: 8,
  },
  {
    name: "Mawrth Vallis",
    fullTitle: "Mawrth Vallis — Exobiology Site",
    lat: 23.99,
    lon: -19.0,
    zoom: 9,
  },
  {
    name: "Meridiani Planum",
    fullTitle: "Meridiani Planum — Opportunity",
    lat: -1.95,
    lon: -5.53,
    zoom: 9,
  },
];

let currentState = {
  lat: -5.4,
  lon: 137.8,
  zoom: 8,
  layer: "CTX_WARM",
  reqId: 0,
};

// =========================================================================
// 2. LEAFLET 2D PANNING MAP (RIGHT BOX)
// =========================================================================
const mars2DMap = L.map("mars-2d-map", {
  crs: L.CRS.EPSG4326,
  center: [currentState.lat, currentState.lon],
  zoom: currentState.zoom,
  minZoom: 3,
  maxZoom: 13,
  zoomControl: false,
});

L.control.zoom({ position: "bottomright" }).addTo(mars2DMap);

let activeTileLayers = [];

function setMapLayer(layerType) {
  activeTileLayers.forEach((l) => mars2DMap.removeLayer(l));
  activeTileLayers = [];

  if (layerType === "CTX_WARM") {
    activeTileLayers.push(
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/MDIM/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 9, maxZoom: 13, className: "ctx-warm-filter" },
      ),
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 12, maxZoom: 13, className: "ctx-warm-filter" },
      ),
    );
  } else if (layerType === "CTX_RAW") {
    activeTileLayers.push(
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 12, maxZoom: 13 },
      ),
    );
  } else if (layerType === "THEMIS_IR") {
    activeTileLayers.push(
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12_clon0_ly/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
        { maxNativeZoom: 8, maxZoom: 13 },
      ),
    );
  } else if (layerType === "MOLA_CLR") {
    activeTileLayers.push(
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
        { maxNativeZoom: 6, maxZoom: 13 },
      ),
    );
  } else if (["TES_THERMAL", "TES_DUST", "TES_CLAY", "MOLA_ROUGHNESS"].includes(layerType)) {
    const layerIds = {
      TES_THERMAL: "TES_Thermal_Inertia",
      TES_DUST: "tes_ruffdust",
      TES_CLAY: "TES_Glass_Clay",
      MOLA_ROUGHNESS: "mola_roughness",
    };
    const productLayer = layerIds[layerType];
    activeTileLayers.push(
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/MDIM/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 9, maxZoom: 13 },
      ),
      L.tileLayer(
        `https://trek.nasa.gov/tiles/Mars/EQ/${productLayer}/1.0.0/default/default028mm/{z}/{y}/{x}.png`,
        { maxNativeZoom: 8, maxZoom: 13, opacity: 0.78 },
      ),
    );
  } else {
    activeTileLayers.push(
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
        { maxNativeZoom: 7, maxZoom: 13 },
      ),
    );
  }

  activeTileLayers.forEach((l) => l.addTo(mars2DMap));
}

setMapLayer(currentState.layer);

const selectedPointMarker = L.circleMarker([0, 0], {
  radius: 7,
  color: "#fff",
  weight: 2,
  fillColor: "#ff9d42",
  fillOpacity: 1,
  className: "selected-point-marker",
}).addTo(mars2DMap);

// =========================================================================
// 3. COORDINATE DATA LOOKUP
// =========================================================================
const GROUP_ORDER = [
  "Terrain",
  "Surface properties",
  "Geology & science",
  "Environment",
  "Radiation",
  "Image interpretation",
  "Derived context",
];

function formatCoordinate(lat, lon) {
  return `LAT ${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} · LON ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
}

function statusLabel(status) {
  return ({
    available: "AVAILABLE",
    partial: "PARTIAL",
    unavailable: "UNAVAILABLE",
    "no-data": "NO SAMPLE",
    "map-only": "MAP OVERLAY",
    "not-configured": "NOT CONNECTED",
    "dataset-only": "DATASET ONLY",
  })[status] || String(status || "UNKNOWN").toUpperCase();
}

function createDataRow(layer) {
  const row = document.createElement("article");
  row.className = `data-row data-${layer.status}`;

  const header = document.createElement("div");
  header.className = "data-row-header";
  const name = document.createElement("strong");
  name.textContent = layer.name;
  const badge = document.createElement("span");
  badge.className = `data-badge badge-${layer.status}`;
  badge.textContent = statusLabel(layer.status);
  header.append(name, badge);

  const value = document.createElement("div");
  value.className = "data-value";
  value.textContent = Number.isFinite(layer.value)
    ? `${layer.value.toFixed(layer.units === "m" ? 1 : 2)} ${layer.units || ""}`.trim()
    : typeof layer.value === "string" && layer.value.length
      ? layer.value
      : layer.message;

  const source = document.createElement("div");
  source.className = "data-source";
  source.textContent = `${layer.kind || "dataset"} · ${layer.source || "Source not provided"}`;

  const resolution = document.createElement("div");
  resolution.className = "data-resolution";
  resolution.textContent = layer.nominalResolution || layer.message || "Coverage/resolution metadata unavailable.";

  row.append(header, value, source, resolution);
  return row;
}

function renderPointData(payload) {
  pointDataEl.replaceChildren();
  if (!Array.isArray(payload.layers) || payload.layers.length === 0) {
    pointDataEl.textContent = "No layer records were returned for this coordinate.";
    return;
  }

  const groups = new Map();
  payload.layers.forEach((layer) => {
    if (!groups.has(layer.group)) groups.set(layer.group, []);
    groups.get(layer.group).push(layer);
  });

  GROUP_ORDER.forEach((groupName) => {
    const layers = groups.get(groupName);
    if (!layers?.length) return;
    const section = document.createElement("section");
    section.className = "data-group";
    const title = document.createElement("h3");
    title.textContent = groupName;
    section.append(title);
    layers.forEach((layer) => section.append(createDataRow(layer)));
    pointDataEl.append(section);
  });

  const note = document.createElement("p");
  note.className = "coverage-note";
  note.textContent = payload.coverageNote || "Source coverage and resolution vary by layer.";
  pointDataEl.append(note);
}

async function updatePointData(lat, lon, titleText, options = {}) {
  const reqId = ++currentState.reqId;
  currentState.lat = lat;
  currentState.lon = lon;
  regionTitleEl.textContent = titleText;
  coordReadoutEl.textContent = formatCoordinate(lat, lon);
  selectedPointMarker.setLatLng([lat, lon]);
  if (options.flyTo) mars2DMap.flyTo([lat, lon], currentState.zoom, { duration: 1.1 });
  pointStatusEl.textContent = "Loading point datasets…";
  pointDataEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "data-hint";
  loading.textContent = "Querying terrain, mapped geology, derived sunlight, and nearby station reports.";
  pointDataEl.append(loading);

  try {
    const response = await fetch(`/api/point?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Point query failed (${response.status})`);
    if (reqId !== currentState.reqId) return;
    pointStatusEl.textContent = payload.resultStatus === "available"
      ? "Point data loaded"
      : payload.resultStatus === "partial"
        ? "Partial data returned"
        : "Point data unavailable";
    renderPointData(payload);
  } catch (error) {
    if (reqId !== currentState.reqId) return;
    pointStatusEl.textContent = "Point query failed";
    pointDataEl.replaceChildren();
    const message = document.createElement("p");
    message.className = "data-error";
    message.textContent = `${error.message}. No estimated values were substituted.`;
    pointDataEl.append(message);
  }
}

function handleMapLocationSelection(lat, lon, name, options = {}) {
  updatePointData(lat, lon, name, options);
}

mars2DMap.on("click", (event) => {
  const { lat, lng } = event.latlng;
  handleMapLocationSelection(lat, lng, "Selected Mars coordinate");
});

pointPanelToggle.addEventListener("click", () => {
  const expanded = pointPanelToggle.getAttribute("aria-expanded") === "true";
  pointPanelToggle.setAttribute("aria-expanded", String(!expanded));
  pointPanelToggle.textContent = expanded ? "+" : "−";
  pointDataEl.hidden = expanded;
});

// =========================================================================
// 5. SIDEBAR REGION LIST POPULATION
// =========================================================================
MARS_REGIONS.forEach((reg) => {
  const btn = document.createElement("button");
  btn.className = "region-item";
  btn.textContent = reg.name;
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".region-item")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentState.zoom = reg.zoom;
    zoomLabelEl.textContent = `Z: ${reg.zoom}`;
    handleMapLocationSelection(reg.lat, reg.lon, reg.fullTitle, { flyTo: true });
  });
  regionListContainer.appendChild(btn);
});

// =========================================================================
// 6. THREE.JS 3D MARS GLOBE & LABELS
// =========================================================================
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 0, 4.15);

const renderer = new THREE.WebGLRenderer({
  canvas: canvas3D,
  alpha: true,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const controls = new OrbitControls(camera, canvas3D);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 2.2;
controls.maxDistance = 7;

scene.add(new THREE.HemisphereLight(0xfbd6bd, 0x260c08, 1.6));
const sunLight = new THREE.DirectionalLight(0xffe2c6, 3.1);
sunLight.position.set(-3.5, 4.2, 5);
scene.add(sunLight);

const planetSpin = new THREE.Group();
scene.add(planetSpin);

function latLonToLocalVector3(lat, lon) {
  const phi = THREE.MathUtils.degToRad(lat);
  const theta = THREE.MathUtils.degToRad(lon - LON_OFFSET);
  const y = GLOBE_RADIUS * Math.sin(phi);
  const rXZ = GLOBE_RADIUS * Math.cos(phi);
  return new THREE.Vector3(rXZ * Math.sin(theta), y, rXZ * Math.cos(theta));
}

const labelItems3D = [];
MARS_REGIONS.forEach((reg) => {
  const el = document.createElement("div");
  el.className = "mars-3d-label";
  el.innerHTML = `<span class="dot"></span><span class="tag">${reg.name}</span>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    userInteracted = true;
    handleMapLocationSelection(reg.lat, reg.lon, reg.fullTitle, { flyTo: true });
  });
  labels3DLayer.appendChild(el);
  labelItems3D.push({ el, localPos: latLonToLocalVector3(reg.lat, reg.lon) });
});

let marsModel = null;
let hasLoaded = false;
let userInteracted = false;

function resizeScene() {
  const w = containerBox.clientWidth;
  const h = containerBox.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resizeScene);
resizeScene();

const loader = new GLTFLoader();
loader.load("./assets/24881_Mars_1_6792.glb", (gltf) => {
  marsModel = gltf.scene;
  const bounds = new THREE.Box3().setFromObject(marsModel);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z);
  marsModel.position.sub(center);
  marsModel.scale.setScalar(2.55 / largest);
  planetSpin.add(marsModel);
  planetSpin.rotation.z = THREE.MathUtils.degToRad(-9);
  planetSpin.rotation.x = THREE.MathUtils.degToRad(4);
  hasLoaded = true;
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownPos = { x: 0, y: 0 };

canvas3D.addEventListener("pointerdown", (e) => {
  pointerDownPos.x = e.clientX;
  pointerDownPos.y = e.clientY;
});

canvas3D.addEventListener("pointerup", (e) => {
  if (!hasLoaded || !marsModel) return;
  if (
    Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 5
  )
    return;

  const rect = canvas3D.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const intersects = raycaster.intersectObject(marsModel, true);

  if (intersects.length > 0) {
    userInteracted = true;
    const localPoint = planetSpin.worldToLocal(intersects[0].point.clone());
    const normal = localPoint.clone().normalize();
    const lat = THREE.MathUtils.radToDeg(Math.asin(normal.y));
    let lon =
      THREE.MathUtils.radToDeg(Math.atan2(normal.x, normal.z)) + LON_OFFSET;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;

    handleMapLocationSelection(
      lat,
      lon,
      `Sector ${lat.toFixed(1)}°, ${lon.toFixed(1)}°`,
      { flyTo: true },
    );
  }
});

const tempWorldPos = new THREE.Vector3();
const tempNormal = new THREE.Vector3();
const tempCamDir = new THREE.Vector3();

function update3DLabelsProjection() {
  const w = containerBox.clientWidth;
  const h = containerBox.clientHeight;
  tempCamDir.copy(camera.position).normalize();

  labelItems3D.forEach((item) => {
    tempWorldPos.copy(item.localPos).applyMatrix4(planetSpin.matrixWorld);
    tempNormal.copy(tempWorldPos).normalize();
    const dot = tempNormal.dot(tempCamDir);

    if (dot > 0.18) {
      tempWorldPos.project(camera);
      const x = (tempWorldPos.x * 0.5 + 0.5) * w;
      const y = (-tempWorldPos.y * 0.5 + 0.5) * h;
      item.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      item.el.style.opacity = Math.min(1, (dot - 0.18) * 3.5).toFixed(2);
      item.el.style.pointerEvents = "auto";
    } else {
      item.el.style.opacity = "0";
      item.el.style.pointerEvents = "none";
    }
  });
}

// UI Layer & Zoom Controls
layerSelectEl.addEventListener("change", (e) => {
  currentState.layer = e.target.value;
  setMapLayer(currentState.layer);
});

document.querySelector("#zoom-in").addEventListener("click", () => {
  if (currentState.zoom < 13) {
    currentState.zoom++;
    zoomLabelEl.textContent = `Z: ${currentState.zoom}`;
    mars2DMap.setZoom(currentState.zoom);
  }
});

document.querySelector("#zoom-out").addEventListener("click", () => {
  if (currentState.zoom > 3) {
    currentState.zoom--;
    zoomLabelEl.textContent = `Z: ${currentState.zoom}`;
    mars2DMap.setZoom(currentState.zoom);
  }
});

// Initial coordinate lookup for Gale Crater
updatePointData(
  currentState.lat,
  currentState.lon,
  "Gale Crater — Curiosity Landing Site",
);

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  if (hasLoaded && !document.hidden && !userInteracted) {
    planetSpin.rotation.y += delta * 0.085;
  }

  controls.update();
  planetSpin.updateMatrixWorld();
  update3DLabelsProjection();
  renderer.render(scene, camera);
}
requestAnimationFrame(animate);
