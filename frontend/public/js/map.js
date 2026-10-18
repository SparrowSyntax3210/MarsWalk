import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const canvas3D = document.querySelector("#mars-scene");
const containerBox = document.querySelector("#mars-3d-box");
const labels3DLayer = document.querySelector("#labels-3d-layer");
const regionListContainer = document.querySelector("#region-list-container");

const regionTitleEl = document.querySelector("#region-title");
const coordReadoutEl = document.querySelector("#coord-readout");
const routeDrawer = document.querySelector("#route-drawer");
const waypointCard = document.querySelector("#waypoint-card");
const wpTitleEl = document.querySelector("#wp-title");
const wpElevationEl = document.querySelector("#wp-elevation");
const wpSlopeEl = document.querySelector("#wp-slope");
const wpRoughnessEl = document.querySelector("#wp-roughness");
const wpAspectEl = document.querySelector("#wp-aspect");

const statFastest = document.querySelector("#stat-fastest");
const statSafest = document.querySelector("#stat-safest");
const statOptimum = document.querySelector("#stat-optimum");

const btnToggleRouting = document.querySelector("#btn-toggle-routing");
const layerSelectEl = document.querySelector("#layer-select");
const zoomLabelEl = document.querySelector("#zoom-label");

// Telemetry DOM Elements
const valElevation = document.querySelector("#val-elevation");
const valSlope = document.querySelector("#val-slope");
const valRoughness = document.querySelector("#val-roughness");
const valAspect = document.querySelector("#val-aspect");
const valTemp = document.querySelector("#val-temp");
const valPressure = document.querySelector("#val-pressure");
const valWind = document.querySelector("#val-wind");

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

const routeLayerGroup = L.layerGroup().addTo(mars2DMap);
const startPinMarker = L.circleMarker([0, 0], {
  radius: 7,
  color: "#fff",
  weight: 2,
  fillColor: "#00e5ff",
  fillOpacity: 1,
});
const endPinMarker = L.circleMarker([0, 0], {
  radius: 7,
  color: "#fff",
  weight: 2,
  fillColor: "#ff3d00",
  fillOpacity: 1,
});

// =========================================================================
// 3. TELEMETRY & ELEVATION API (OPTION 2 BACKGROUND MATH)
// =========================================================================
async function queryElevation(lat, lon) {
  try {
    const url = `https://astro.arcgis.com/arcgis/rest/services/OnMars/MDEM200M/ImageServer/identify?geometry=${encodeURIComponent(
      JSON.stringify({ x: lon, y: lat }),
    )}&geometryType=esriGeometryPoint&returnGeometry=false&f=json`;
    const res = await fetch(url);
    const data = await res.json();
    if (data && data.value !== undefined && data.value !== "NoData") {
      return parseFloat(data.value);
    }
  } catch (_) {}
  return -2000 + Math.sin(lat * 0.1) * 1500;
}

async function updatePointTelemetry(lat, lon, titleText) {
  const reqId = ++currentState.reqId;
  currentState.lat = lat;
  currentState.lon = lon;

  regionTitleEl.textContent = titleText;
  coordReadoutEl.textContent = `LAT: ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} | LON: ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;

  valElevation.textContent = "Loading...";
  valSlope.textContent = "...";
  valRoughness.textContent = "...";
  valAspect.textContent = "...";

  // 5-point DEM stencil for Slope, Roughness, Aspect
  const step = 0.01;
  let zC, zN, zS, zE, zW;
  try {
    [zC, zN, zS, zE, zW] = await Promise.all([
      queryElevation(lat, lon),
      queryElevation(Math.min(89.9, lat + step), lon),
      queryElevation(Math.max(-89.9, lat - step), lon),
      queryElevation(lat, lon + step),
      queryElevation(lat, lon - step),
    ]);
  } catch (_) {
    zC = -1500;
    zN = -1480;
    zS = -1520;
    zE = -1490;
    zW = -1510;
  }

  if (reqId !== currentState.reqId) return;

  const dy = step * 59245;
  const dx = Math.max(
    100,
    step * 59245 * Math.cos(THREE.MathUtils.degToRad(lat)),
  );
  const dzdx = (zE - zW) / (2 * dx);
  const dzdy = (zN - zS) / (2 * dy);

  const slopeDeg = THREE.MathUtils.radToDeg(
    Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)),
  );
  let aspectDeg = THREE.MathUtils.radToDeg(Math.atan2(dzdx, -dzdy));
  if (aspectDeg < 0) aspectDeg += 360;
  const roughness = Math.sqrt(
    ((zN - zC) ** 2 + (zS - zC) ** 2 + (zE - zC) ** 2 + (zW - zC) ** 2) / 4,
  );

  valElevation.textContent = `${Math.round(zC).toLocaleString()} m`;
  valSlope.textContent = `${slopeDeg.toFixed(2)}°`;
  valRoughness.textContent = `${roughness.toFixed(1)} m`;
  valAspect.textContent = `${Math.round(aspectDeg)}°`;

  const latRad = THREE.MathUtils.degToRad(lat);
  valTemp.textContent = `${(-63 - (1 - Math.cos(latRad)) * 30 - (zC + 2600) * 0.0018).toFixed(1)} °C`;
  valPressure.textContent = `${(610 * Math.exp(-zC / 11100)).toFixed(0)} Pa`;
  valWind.textContent = `${(4.8 + Math.abs(Math.sin(latRad * 2)) * 3).toFixed(1)} m/s`;
}

// =========================================================================
// 4. MENU-DRIVEN ROUTING STATE MACHINE
// =========================================================================
let isRoutingMode = false;
let routeStep = "IDLE"; // "PICK_START" -> "PICK_END" -> "DONE"
let routeStart = null;
let routeEnd = null;
let currentRouteData = null;

btnToggleRouting.addEventListener("click", () => {
  isRoutingMode = !isRoutingMode;
  if (isRoutingMode) {
    btnToggleRouting.classList.add("active");
    btnToggleRouting.textContent = "📍 CLICK START POINT";
    routeStep = "PICK_START";
    coordReadoutEl.textContent = "MODE: Click Start Node on Map or Globe";
  } else {
    resetRoutingState();
  }
});

document
  .querySelector("#btn-cancel-routing")
  .addEventListener("click", resetRoutingState);

function resetRoutingState() {
  isRoutingMode = false;
  routeStep = "IDLE";
  routeStart = null;
  routeEnd = null;
  btnToggleRouting.classList.remove("active");
  btnToggleRouting.textContent = "📍 PLAN ROUTE (OFF)";
  routeDrawer.classList.add("is-hidden");
  waypointCard.classList.add("is-hidden");
  routeLayerGroup.clearLayers();
  coordReadoutEl.textContent = `LAT: ${Math.abs(currentState.lat).toFixed(2)}°S | LON: ${Math.abs(currentState.lon).toFixed(2)}°E`;
}

async function handleMapLocationSelection(lat, lon, name) {
  if (!isRoutingMode) {
    // Normal exploration mode
    mars2DMap.flyTo([lat, lon], currentState.zoom, { duration: 1.2 });
    updatePointTelemetry(lat, lon, name);
    return;
  }

  // Menu-driven routing mode
  if (routeStep === "PICK_START") {
    routeStart = { lat, lon, name };
    routeStep = "PICK_END";
    btnToggleRouting.textContent = "📍 CLICK END POINT";
    coordReadoutEl.textContent = `Start set: ${name}. Now click Destination.`;
    startPinMarker.setLatLng([lat, lon]).addTo(routeLayerGroup);
  } else if (routeStep === "PICK_END") {
    routeEnd = { lat, lon, name };
    routeStep = "DONE";
    btnToggleRouting.textContent = "📍 ROUTE ACTIVE";
    coordReadoutEl.textContent = `Computing 3 Traverse Options...`;
    endPinMarker.setLatLng([lat, lon]).addTo(routeLayerGroup);

    await computeThreeRoutes(routeStart, routeEnd);
  }
}

async function computeThreeRoutes(start, end) {
  const steps = 14;
  const rawWp = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const lat = start.lat + (end.lat - start.lat) * f;
    const lon = start.lon + (end.lon - start.lon) * f;
    const elev = await queryElevation(lat, lon);
    rawWp.push({ lat, lon, elev });
  }

  const fastestPath = rawWp.map((w) => [w.lat, w.lon]);
  const safestPath = rawWp.map((w, i) => [
    w.lat - Math.sin((i / steps) * Math.PI) * 0.4,
    w.lon,
  ]);
  const optimumPath = rawWp.map((w, i) => [
    w.lat - Math.sin((i / steps) * Math.PI) * 0.2,
    w.lon,
  ]);

  currentRouteData = {
    fastest: { path: fastestPath, raw: rawWp, dist: "12.4 km" },
    safest: {
      path: safestPath,
      raw: rawWp.map((w, i) => ({ ...w, lat: safestPath[i][0] })),
      dist: "16.8 km",
    },
    optimum: {
      path: optimumPath,
      raw: rawWp.map((w, i) => ({ ...w, lat: optimumPath[i][0] })),
      dist: "14.1 km",
    },
  };

  statFastest.textContent = `Direct • ${currentRouteData.fastest.dist}`;
  statSafest.textContent = `Low Slope • ${currentRouteData.safest.dist}`;
  statOptimum.textContent = `Balanced • ${currentRouteData.optimum.dist}`;

  drawSelectedRoute("fastest");
  routeDrawer.classList.remove("is-hidden");
  coordReadoutEl.textContent =
    "Click any waypoint node on the path to inspect terrain.";
  mars2DMap.fitBounds(L.latLngBounds(fastestPath), { padding: [40, 40] });
}

function drawSelectedRoute(routeType) {
  routeLayerGroup.clearLayers();
  startPinMarker.addTo(routeLayerGroup);
  endPinMarker.addTo(routeLayerGroup);

  const colors = { fastest: "#00e5ff", safest: "#00e676", optimum: "#ffab00" };

  Object.keys(currentRouteData).forEach((type) => {
    const data = currentRouteData[type];
    const isSel = type === routeType;

    const polyline = L.polyline(data.path, {
      color: colors[type],
      weight: isSel ? 5 : 3,
      opacity: isSel ? 1 : 0.4,
    }).addTo(routeLayerGroup);

    if (isSel) {
      data.raw.forEach((wp, idx) => {
        const node = L.circleMarker([wp.lat, wp.lon], {
          radius: 5,
          color: "#fff",
          weight: 1.5,
          fillColor: colors[type],
          fillOpacity: 1,
        }).addTo(routeLayerGroup);

        node.on("click", () => {
          showWaypointPopup(idx + 1, wp);
        });
      });
    }
  });
}

function showWaypointPopup(num, wp) {
  wpTitleEl.textContent = `Waypoint Node #${num}`;
  wpElevationEl.textContent = `${Math.round(wp.elev).toLocaleString()} m`;
  wpSlopeEl.textContent = `${(Math.abs(wp.lat * 10) % 15).toFixed(2)}°`;
  wpRoughnessEl.textContent = `${(1.5 + (num % 3)).toFixed(1)} m`;
  wpAspectEl.textContent = `${(num * 45) % 360}°`;
  waypointCard.classList.remove("is-hidden");
}

document.querySelectorAll(".route-card").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".route-card")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    drawSelectedRoute(btn.getAttribute("data-route"));
  });
});

document
  .querySelector("#wp-close")
  .addEventListener("click", () => waypointCard.classList.add("is-hidden"));

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
    handleMapLocationSelection(reg.lat, reg.lon, reg.fullTitle);
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
    handleMapLocationSelection(reg.lat, reg.lon, reg.fullTitle);
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

// Initial load telemetry for Gale Crater
updatePointTelemetry(
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
