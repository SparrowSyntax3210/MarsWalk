import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { initMissionPlanner } from "./mission-planner.js";

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
const routePlanButton = document.querySelector("#route-plan-button");
const routeModeSelect = document.querySelector("#route-mode-select");
const routeVisionToggle = document.querySelector("#route-vision-toggle");
const routeHintEl = document.querySelector("#route-hint");
const routePanel = document.querySelector("#route-panel");
const routeStartLatInput = document.querySelector("#route-start-lat");
const routeStartLonInput = document.querySelector("#route-start-lon");
const routeEndLatInput = document.querySelector("#route-end-lat");
const routeEndLonInput = document.querySelector("#route-end-lon");
const startCoordinateLabel = document.querySelector("#start-coordinate-label");
const endCoordinateLabel = document.querySelector("#end-coordinate-label");
const locationCountEl = document.querySelector("#location-count");
const locationSearchEl = document.querySelector("#location-search");
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

const CURATED_REGION_NAMES = new Set(
  MARS_REGIONS.map((region) => region.name.toLowerCase()),
);

let currentState = {
  lat: -5.4,
  lon: 137.8,
  zoom: 8,
  layer: "HIRISE_AUTO",
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
  maxZoom: 18,
  zoomControl: false,
});

mars2DMap.createPane("mars-locations-pane").style.zIndex = "410";
mars2DMap.createPane("mars-routes-pane").style.zIndex = "420";
mars2DMap.createPane("mars-selection-pane").style.zIndex = "430";

L.control.zoom({ position: "bottomright" }).addTo(mars2DMap);

let activeTileLayers = [];
let routeSelectionActive = false;
let routeSelectionTarget = null;
let routeStart = null;
let routeEnd = null;
let routeStartMarker = null;
let routeEndMarker = null;
let plannedRouteLayer = null;
let plannedRouteGlobeLayer = null;
let routeStartGlobeMarker = null;
let routeEndGlobeMarker = null;
let marsFeatures = [];
let featurePointCloud = null;
let lastFeatureNameRender = 0;
let featureMarkerLayer = null;
let selectedCoordinatePoint = null;
let selectedFeatureLabelPosition = null;

function setMapLayer(layerType) {
  activeTileLayers.forEach((l) => mars2DMap.removeLayer(l));
  activeTileLayers = [];

  if (layerType === "HIRISE_AUTO") {
    // Keep CTX below HiRISE so missing/transparent tiles reveal broad-coverage context.
    activeTileLayers.push(
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 12, maxZoom: 18, className: "mars-warm-filter" },
      ),
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/HiRISE/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 18, maxZoom: 18, zoomOffset: -1, opacity: 1, className: "mars-warm-filter" },
      ),
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/1.0.0/default/default028mm/{z}/{y}/{x}.png",
        { maxNativeZoom: 18, maxZoom: 18, zoomOffset: -1, opacity: 1, className: "mars-warm-filter" },
      ),
    );
  } else if (layerType === "CTX_WARM") {
    activeTileLayers.push(
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/MDIM/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 9, maxZoom: 18, className: "mars-warm-filter" },
      ),
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 12, maxZoom: 18, className: "mars-warm-filter" },
      ),
    );
  } else if (layerType === "CTX_RAW") {
    activeTileLayers.push(
      L.tileLayer(
        "https://astro.arcgis.com/arcgis/rest/services/OnMars/CTX1/MapServer/tile/{z}/{y}/{x}",
        { maxNativeZoom: 12, maxZoom: 18 },
      ),
    );
  } else if (layerType === "THEMIS_IR") {
    activeTileLayers.push(
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12_clon0_ly/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
        { maxNativeZoom: 8, maxZoom: 18, zoomOffset: -1 },
      ),
    );
  } else if (layerType === "MOLA_CLR") {
    activeTileLayers.push(
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
        { maxNativeZoom: 6, maxZoom: 18, zoomOffset: -1 },
      ),
    );
  } else if (
    ["TES_THERMAL", "TES_DUST", "TES_CLAY", "MOLA_ROUGHNESS"].includes(
      layerType,
    )
  ) {
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
        { maxNativeZoom: 9, maxZoom: 18 },
      ),
      L.tileLayer(
        `https://trek.nasa.gov/tiles/Mars/EQ/${productLayer}/1.0.0/default/default028mm/{z}/{y}/{x}.png`,
        { maxNativeZoom: 8, maxZoom: 18, zoomOffset: -1, opacity: 0.78 },
      ),
    );
  } else {
    activeTileLayers.push(
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg",
        { maxNativeZoom: 7, maxZoom: 18, zoomOffset: -1 },
      ),
    );
  }

  activeTileLayers.forEach((l) => l.addTo(mars2DMap));
}

setMapLayer(currentState.layer);

const selectedPointMarker = L.circleMarker([0, 0], {
  pane: "mars-selection-pane",
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
  return (
    {
      available: "AVAILABLE",
      partial: "PARTIAL",
      unavailable: "UNAVAILABLE",
      "no-data": "NO SAMPLE",
      "map-only": "MAP OVERLAY",
      "not-configured": "NOT CONNECTED",
      "dataset-only": "DATASET ONLY",
    }[status] || String(status || "UNKNOWN").toUpperCase()
  );
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
  resolution.textContent =
    layer.nominalResolution ||
    layer.message ||
    "Coverage/resolution metadata unavailable.";

  row.append(header, value, source, resolution);
  return row;
}

function renderPointData(payload) {
  pointDataEl.replaceChildren();
  if (!Array.isArray(payload.layers) || payload.layers.length === 0) {
    pointDataEl.textContent =
      "No layer records were returned for this coordinate.";
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
  note.textContent =
    payload.coverageNote || "Source coverage and resolution vary by layer.";
  pointDataEl.append(note);
}

async function updatePointData(lat, lon, titleText, options = {}) {
  const reqId = ++currentState.reqId;
  currentState.lat = lat;
  currentState.lon = lon;
  regionTitleEl.textContent = titleText;
  coordReadoutEl.textContent = formatCoordinate(lat, lon);
  selectedPointMarker.setLatLng([lat, lon]);
  updateSelectedCoordinateMarker(lat, lon);
  updateSelectedFeatureLabel(lat, lon, titleText);
  if (options.flyTo)
    mars2DMap.flyTo([lat, lon], currentState.zoom, { duration: 1.1 });
  pointStatusEl.textContent = "Loading point datasets…";
  pointDataEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "data-hint";
  loading.textContent =
    "Querying terrain, mapped geology, derived sunlight, and nearby station reports.";
  pointDataEl.append(loading);

  try {
    const response = await fetch(
      `/api/point?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
      {
        headers: { Accept: "application/json" },
      },
    );
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        payload.error || `Point query failed (${response.status})`,
      );
    if (reqId !== currentState.reqId) return;
    pointStatusEl.textContent =
      payload.resultStatus === "available"
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

function updateRouteGlobeMarker(which, lat, lon) {
  let marker = which === "start" ? routeStartGlobeMarker : routeEndGlobeMarker;
  const color = which === "start" ? 0x00d084 : 0xff5370;
  if (!marker) {
    marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.027, 12, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    marker.userData.routeEndpoint = which;
    planetSpin.add(marker);
    if (which === "start") routeStartGlobeMarker = marker;
    else routeEndGlobeMarker = marker;
  }
  marker.position.copy(latLonToLocalVector3(lat, lon).normalize().multiplyScalar(GLOBE_RADIUS + 0.045));
}

function disposePlannedGlobeRoute() {
  if (!plannedRouteGlobeLayer) return;
  planetSpin.remove(plannedRouteGlobeLayer);
  plannedRouteGlobeLayer.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
    else object.material.dispose();
  });
  plannedRouteGlobeLayer = null;
}

function terrainClassColor(className) {
  return ({ impassable: "#ff4358", high: "#ff873d", caution: "#ffd34f", safe: "#43d6a3", unknown: "#f1f3f5" })[className] || "#00e5ff";
}
function setRouteEndpoint(which, lat, lon) {
  if (plannedRouteLayer) {
    mars2DMap.removeLayer(plannedRouteLayer);
    plannedRouteLayer = null;
  }
  disposePlannedGlobeRoute();
  const point = { lat: Number(lat), lon: Number(lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) || point.lat < -90 || point.lat > 90 || point.lon < -180 || point.lon > 180) {
    routeHintEl.textContent = "Enter a valid latitude (−90 to 90) and longitude (−180 to 180).";
    return false;
  }
  const isStart = which === "start";
  if (isStart) routeStart = point;
  else routeEnd = point;

  let marker = isStart ? routeStartMarker : routeEndMarker;
  const fillColor = isStart ? "#00d084" : "#ff5370";
  if (!marker) {
    marker = L.circleMarker([point.lat, point.lon], {
      pane: "mars-routes-pane", radius: 7, color: "#fff", weight: 2,
      fillColor, fillOpacity: 1,
    }).addTo(mars2DMap);
    if (isStart) routeStartMarker = marker;
    else routeEndMarker = marker;
  } else {
    marker.setLatLng([point.lat, point.lon]);
  }
  updateRouteGlobeMarker(which, point.lat, point.lon);
  mars2DMap.panTo([point.lat, point.lon], { animate: true, duration: 0.45 });

  const latInput = isStart ? routeStartLatInput : routeEndLatInput;
  const lonInput = isStart ? routeStartLonInput : routeEndLonInput;
  const coordinateLabel = isStart ? startCoordinateLabel : endCoordinateLabel;
  latInput.value = point.lat.toFixed(4);
  lonInput.value = point.lon.toFixed(4);
  coordinateLabel.textContent = point.lat.toFixed(3) + ", " + point.lon.toFixed(3);
  const missionLat = document.querySelector(isStart ? "#mission-start-lat" : "#mission-end-lat");
  const missionLon = document.querySelector(isStart ? "#mission-start-lon" : "#mission-end-lon");
  if (missionLat) missionLat.value = point.lat.toFixed(4);
  if (missionLon) missionLon.value = point.lon.toFixed(4);
  routePlanButton.disabled = !(routeStart && routeEnd);
  routeHintEl.textContent = (isStart ? "Start" : "Destination") + " set · choose the other endpoint or calculate the route.";
  return true;
}

function handleRoutePointSelection(lat, lon) {
  if (!routeSelectionActive || !routeSelectionTarget) return;
  const selected = routeSelectionTarget;
  routeSelectionActive = false;
  routeSelectionTarget = null;
  document.querySelectorAll("[data-route-pick]").forEach((button) => button.classList.remove("is-picking"));
  setRouteEndpoint(selected, lat, lon);
}

function clearRoutePlan() {
  routeSelectionActive = false;
  routeSelectionTarget = null;
  routeStart = null;
  routeEnd = null;
  [routeStartMarker, routeEndMarker].forEach((marker) => { if (marker) mars2DMap.removeLayer(marker); });
  routeStartMarker = null;
  routeEndMarker = null;
  if (plannedRouteLayer) mars2DMap.removeLayer(plannedRouteLayer);
  plannedRouteLayer = null;
  disposePlannedGlobeRoute();

  if (routeStartGlobeMarker) planetSpin.remove(routeStartGlobeMarker);
  if (routeEndGlobeMarker) planetSpin.remove(routeEndGlobeMarker);
  routeStartGlobeMarker = null;
  routeEndGlobeMarker = null;
  routeStartLatInput.value = "";
  routeStartLonInput.value = "";
  routeEndLatInput.value = "";
  routeEndLonInput.value = "";
  ["#mission-start-lat", "#mission-start-lon", "#mission-end-lat", "#mission-end-lon"].forEach((selector) => {
    const input = document.querySelector(selector);
    if (input) input.value = "";
  });
  startCoordinateLabel.textContent = "Not set";
  endCoordinateLabel.textContent = "Not set";
  routePlanButton.disabled = true;
  document.querySelectorAll("[data-route-pick]").forEach((button) => button.classList.remove("is-picking"));
  document.querySelector("#terrain-class-summary").textContent = "Route class counts appear after planning.";
  routeHintEl.textContent = "Choose start and destination points on the globe or map.";
}

function renderMarsRoute(payload) {
  if (plannedRouteLayer) mars2DMap.removeLayer(plannedRouteLayer);
  plannedRouteLayer = null;
  disposePlannedGlobeRoute();
  const snappedStart = payload.endpoints.start;
  const snappedEnd = payload.endpoints.end;
  setRouteEndpoint("start", snappedStart.lat, snappedStart.lon);
  setRouteEndpoint("end", snappedEnd.lat, snappedEnd.lon);
  const coordinates = payload.route.geometry.coordinates;
  const latLngs = coordinates.map(([routeLon, routeLat]) => [routeLat, routeLon]);
  const routeDetails = payload.route_cell_details || [];
  plannedRouteLayer = L.layerGroup().addTo(mars2DMap);
  for (let index = 0; index < latLngs.length - 1; index += 1) {
    const cellClass = routeDetails[index + 1]?.class || "unknown";
    L.polyline([latLngs[index], latLngs[index + 1]], {
      pane: "mars-routes-pane", color: terrainClassColor(cellClass), weight: 4, opacity: 0.97,
    }).addTo(plannedRouteLayer);
  }
  const terrainStatus = payload.terrain_data?.status;
  const maxRouteZoom = payload.terrain_data?.instrument === "HiRISE"
    ? 16
    : terrainStatus === "global_dem_window" ? 12
      : terrainStatus === "local_dtm" ? 14 : 10;
  mars2DMap.fitBounds(L.latLngBounds(latLngs), { padding: [30, 30], maxZoom: maxRouteZoom });

  const globePoints = coordinates.map(([routeLon, routeLat]) => latLonToLocalVector3(routeLat, routeLon).normalize().multiplyScalar(GLOBE_RADIUS + 0.035));
  plannedRouteGlobeLayer = new THREE.Group();
  for (let index = 0; index < globePoints.length - 1; index += 1) {
    const cellClass = routeDetails[index + 1]?.class || "unknown";
    const segment = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.LineCurve3(globePoints[index], globePoints[index + 1]), 1, 0.006, 6, false),
      new THREE.MeshBasicMaterial({ color: terrainClassColor(cellClass) }),
    );
    plannedRouteGlobeLayer.add(segment);
  }
  planetSpin.add(plannedRouteGlobeLayer);

  const classCounts = payload.terrain_assessment?.class_counts_on_route || {};
  document.querySelector("#terrain-class-summary").textContent = "Route cells: " +
    (classCounts.safe || 0) + " safe · " + (classCounts.caution || 0) + " caution · " +
    (classCounts.high || 0) + " high · impassable cells are avoided.";
  const metrics = payload.metrics;
  const terrainSource = ["local_dtm", "global_dem_window"].includes(terrainStatus)
    ? payload.terrain_data.instrument + " · " + payload.terrain_data.native_posting_m + " m posting · " + payload.terrain_data.route_grid_m + " m route grid"
    : "global Parquet terrain fallback";
  const fallbackWarning = payload.terrain_data?.fallback_reason
    ? " · CAUTION: higher-resolution terrain rejected an endpoint; coarser fallback used"
    : "";
  const visionNote = payload.vision_model?.requested
    ? payload.vision_model?.status?.startsWith("used_")
      ? " · experimental vision cost · " + Math.round((payload.vision_model.coverage_fraction_of_route_search_grid || 0) * 100) + "% grid coverage"
      : " · vision layer unavailable for this route area"
    : "";
  routeHintEl.textContent = payload.mode + " route · " + metrics.distance_km + " km · max slope " + metrics.max_slope_deg + "° · " + terrainSource + " · snapped " + snappedStart.snap_distance_km + "/" + snappedEnd.snap_distance_km + " km" + fallbackWarning + visionNote + ".";
}

async function calculateMarsRoute(options = {}) {
  if (!routeStart || !routeEnd) {
    routeHintEl.textContent = "Choose both a start and destination first.";
    return;
  }
  // Clear the previous result before recomputing. If the new endpoints are
  // blocked or the planner fails, an old line must not look like a fresh route.
  if (plannedRouteLayer) mars2DMap.removeLayer(plannedRouteLayer);
  plannedRouteLayer = null;
  disposePlannedGlobeRoute();
  document.querySelector("#terrain-class-summary").textContent = "Checking terrain and calculating a new route…";
  routePlanButton.disabled = true;
  routePlanButton.textContent = "Calculating…";
  routeHintEl.textContent = "Checking local HiRISE/CTX stereo DTM coverage, then the global Parquet grid…";
  try {
    const response = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        start: routeStart, end: routeEnd, mode: routeModeSelect.value || "balanced",
        use_vision_model: options.useVision ?? Boolean(routeVisionToggle?.checked),
        vision_weight: (options.useVision ?? Boolean(routeVisionToggle?.checked)) ? 0.15 : 0,
        ...(Number.isFinite(options.maxSlope) ? { max_slope_deg: options.maxSlope } : {}),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Route calculation failed (" + response.status + ")");
    if (plannedRouteLayer) mars2DMap.removeLayer(plannedRouteLayer);
    disposePlannedGlobeRoute();
    renderMarsRoute(payload);
    return payload;
  } catch (error) {
    routeHintEl.textContent = "Route unavailable: " + error.message;
    return null;
  } finally {
    routePlanButton.disabled = !(routeStart && routeEnd);
    routePlanButton.textContent = "Calculate route";
  }
}
mars2DMap.on("click", (event) => {
  const { lat, lng } = event.latlng;
  handleMapLocationSelection(lat, lng, "Selected Mars coordinate");
  handleRoutePointSelection(lat, lng);
});

pointPanelToggle.addEventListener("click", () => {
  const expanded = pointPanelToggle.getAttribute("aria-expanded") === "true";
  pointPanelToggle.setAttribute("aria-expanded", String(!expanded));
  pointPanelToggle.textContent = expanded ? "+" : "−";
  pointDataEl.hidden = expanded;
});

// =========================================================================
// 5. SEARCHABLE LOCATION CATALOG
// =========================================================================
function populateLocationCatalog(features) {
  const catalog = [...features];
  const names = new Set(catalog.map((feature) => feature.name.toLowerCase()));

  MARS_REGIONS.forEach((region) => {
    if (!names.has(region.name.toLowerCase())) {
      catalog.push({
        name: region.name,
        lat: region.lat,
        lon: region.lon,
        fullTitle: region.fullTitle,
        zoom: region.zoom,
        type: "Mission site",
      });
    }
  });

  catalog.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  const fragment = document.createDocumentFragment();
  const entries = [];
  let activeButton = null;

  catalog.forEach((feature) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "region-item";
    button.textContent = feature.name;
    button.title = feature.type || feature.name;
    button.setAttribute("role", "option");
    button.addEventListener("click", () => {
      if (activeButton) activeButton.classList.remove("active");
      activeButton = button;
      button.classList.add("active");

      const mission = MARS_REGIONS.find(
        (region) => region.name.toLowerCase() === feature.name.toLowerCase(),
      );
      currentState.zoom = mission?.zoom || 9;
      zoomLabelEl.textContent = "Z: " + currentState.zoom;
      handleMapLocationSelection(
        feature.lat,
        feature.lon,
        feature.fullTitle || feature.name,
        { flyTo: true },
      );
      handleRoutePointSelection(feature.lat, feature.lon);

    });
    fragment.appendChild(button);
    entries.push({ feature, button });
  });

  const emptyMessage = document.createElement("p");
  emptyMessage.className = "location-empty";
  emptyMessage.textContent = "No matching locations.";
  emptyMessage.hidden = true;
  fragment.appendChild(emptyMessage);
  regionListContainer.replaceChildren(fragment);

  function filterLocations() {
    const query = locationSearchEl.value.trim().toLocaleLowerCase();
    let visible = 0;
    entries.forEach(({ feature, button }) => {
      const matches = feature.name.toLocaleLowerCase().includes(query);
      button.hidden = !matches;
      if (matches) visible += 1;
    });
    emptyMessage.hidden = visible > 0;
    locationCountEl.textContent = query
      ? visible.toLocaleString() +
        " matches · " +
        catalog.length.toLocaleString() +
        " locations"
      : catalog.length.toLocaleString() + " locations · search or scroll";
  }

  locationSearchEl.value = "";
  locationSearchEl.addEventListener("input", filterLocations);
  filterLocations();
}

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

const FEATURE_MARKER_RADIUS = GLOBE_RADIUS + 0.018;

function createLocationDotTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(16, 16, 11, 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = "#563522";
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

const labelItems3D = [];
const featureNamesCanvas = document.createElement("canvas");
featureNamesCanvas.className = "mars-3d-feature-names";
labels3DLayer.appendChild(featureNamesCanvas);
const featureNamesContext = featureNamesCanvas.getContext("2d");
const selectedFeatureLabel = document.createElement("div");
selectedFeatureLabel.className = "mars-3d-label mars-3d-selected-label";
selectedFeatureLabel.innerHTML =
  '<span class="dot"></span><span class="tag"></span>';
selectedFeatureLabel.style.opacity = "0";
labels3DLayer.appendChild(selectedFeatureLabel);
const selectedFeatureTag = selectedFeatureLabel.querySelector(".tag");
MARS_REGIONS.forEach((reg) => {
  const el = document.createElement("div");
  el.className = "mars-3d-label";
  el.innerHTML = `<span class="dot"></span><span class="tag">${reg.name}</span>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    userInteracted = true;
    handleMapLocationSelection(reg.lat, reg.lon, reg.fullTitle, {
      flyTo: true,
    });
    handleRoutePointSelection(reg.lat, reg.lon);

  });
  labels3DLayer.appendChild(el);
  labelItems3D.push({
    el,
    name: reg.name,
    localPos: latLonToLocalVector3(reg.lat, reg.lon),
  });
});

let marsModel = null;
let hasLoaded = false;
let userInteracted = false;

function updateSelectedCoordinateMarker(lat, lon) {
  if (!selectedCoordinatePoint) return;
  const point = latLonToLocalVector3(lat, lon)
    .normalize()
    .multiplyScalar(FEATURE_MARKER_RADIUS + 0.014);
  const positions = selectedCoordinatePoint.geometry.attributes.position;
  positions.setXYZ(0, point.x, point.y, point.z);
  positions.needsUpdate = true;
}

function updateSelectedFeatureLabel(lat, lon, titleText) {
  if (!selectedFeatureTag) return;
  if (
    !titleText ||
    titleText === "Selected Mars coordinate" ||
    titleText.startsWith("Sector ")
  ) {
    selectedFeatureLabelPosition = null;
    return;
  }
  selectedFeatureTag.textContent = titleText;
  selectedFeatureLabelPosition = latLonToLocalVector3(lat, lon)
    .normalize()
    .multiplyScalar(FEATURE_MARKER_RADIUS + 0.02);
}

function addSelectedCoordinatePoint() {
  const selectedGeometry = new THREE.BufferGeometry();
  selectedGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(3), 3),
  );
  selectedCoordinatePoint = new THREE.Points(
    selectedGeometry,
    new THREE.PointsMaterial({
      color: 0xff9d42,
      map: createLocationDotTexture(),
      size: 17,
      sizeAttenuation: false,
      transparent: true,
      depthWrite: false,
    }),
  );
  selectedCoordinatePoint.frustumCulled = false;
  selectedCoordinatePoint.renderOrder = 3;
  planetSpin.add(selectedCoordinatePoint);
  updateSelectedCoordinateMarker(currentState.lat, currentState.lon);
}

addSelectedCoordinatePoint();

function addMarsFeaturePointCloud(features) {
  const positions = new Float32Array(features.length * 3);
  features.forEach((feature, index) => {
    const point = latLonToLocalVector3(feature.lat, feature.lon)
      .normalize()
      .multiplyScalar(FEATURE_MARKER_RADIUS);
    positions[index * 3] = point.x;
    positions[index * 3 + 1] = point.y;
    positions[index * 3 + 2] = point.z;
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  featurePointCloud = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xf4e9dc,
      map: createLocationDotTexture(),
      size: 8,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
    }),
  );
  featurePointCloud.frustumCulled = false;
  featurePointCloud.renderOrder = 2;
  planetSpin.add(featurePointCloud);
}

function addMarsFeatureMapMarkers(features) {
  const markerRenderer = L.canvas({
    pane: "mars-locations-pane",
    padding: 0.5,
  });
  featureMarkerLayer = L.layerGroup().addTo(mars2DMap);

  features.forEach((feature) => {
    const marker = L.circleMarker([feature.lat, feature.lon], {
      pane: "mars-locations-pane",
      renderer: markerRenderer,
      radius: 2.5,
      color: "#493020",
      weight: 1,
      fillColor: "#fff4e8",
      fillOpacity: 0.95,
      bubblingMouseEvents: false,
    });
    marker.bindTooltip(feature.name, {
      permanent: true,
      direction: "right",
      offset: [7, 0],
      opacity: 0.9,
      className: "mars-location-name-label",
    });
    marker.on("click", () => {
      handleMapLocationSelection(feature.lat, feature.lon, feature.name);
      handleRoutePointSelection(feature.lat, feature.lon);
    });
    featureMarkerLayer.addLayer(marker);
  });
}

async function loadMarsFeatureLocations() {
  try {
    const response = await fetch("./data/mars-locations.json", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new Error("Location data request failed (" + response.status + ")");
    const data = await response.json();
    if (!Array.isArray(data.features))
      throw new Error("The Mars location dataset is invalid.");

    marsFeatures = data.features.filter(
      (feature) =>
        Number.isFinite(feature.lat) &&
        Number.isFinite(feature.lon) &&
        typeof feature.name === "string" &&
        feature.name.length > 0,
    );

    addMarsFeatureMapMarkers(marsFeatures);
    addMarsFeaturePointCloud(marsFeatures);
    populateLocationCatalog(marsFeatures);
    if (locationCountEl) {
      locationCountEl.textContent =
        marsFeatures.length.toLocaleString() +
        " names on 2D + front-facing globe";
    }
  } catch (error) {
    if (locationCountEl)
      locationCountEl.textContent = "Named feature markers unavailable";
    if (regionListContainer)
      regionListContainer.textContent = "Location list unavailable";
    console.error("Could not load the Mars feature gazetteer:", error);
  }
}

function renderFrontSideFeatureNames3D(now) {
  if (!featurePointCloud || now - lastFeatureNameRender < 1000 / 15) return;
  lastFeatureNameRender = now;

  const width = containerBox.clientWidth;
  const height = containerBox.clientHeight;
  const pixelRatio = renderer.getPixelRatio();
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (
    featureNamesCanvas.width !== pixelWidth ||
    featureNamesCanvas.height !== pixelHeight
  ) {
    featureNamesCanvas.width = pixelWidth;
    featureNamesCanvas.height = pixelHeight;
  }

  const context = featureNamesContext;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.font = "10px system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.lineJoin = "round";
  context.lineWidth = 3;
  context.strokeStyle = "rgba(20, 10, 6, 0.98)";
  context.fillStyle = "#fff7ed";

  tempCamDir.copy(camera.position).normalize();
  const occupied = [];
  const overlaps = (a, b) =>
    !(
      a.right + 8 <= b.left ||
      b.right + 8 <= a.left ||
      a.bottom + 5 <= b.top ||
      b.bottom + 5 <= a.top
    );

  // Keep the fixed mission-region labels clear of the gazetteer names.
  labelItems3D.forEach((item) => {
    tempWorldPos.copy(item.localPos).applyMatrix4(planetSpin.matrixWorld);
    tempNormal.copy(tempWorldPos).normalize();
    if (tempNormal.dot(tempCamDir) <= 0.18) return;
    tempWorldPos.project(camera);
    const x = (tempWorldPos.x * 0.5 + 0.5) * width;
    const y = (-tempWorldPos.y * 0.5 + 0.5) * height;
    occupied.push({
      left: x,
      right: x + Math.min(150, item.name.length * 6 + 18),
      top: y - 10,
      bottom: y + 10,
    });
  });

  if (selectedFeatureLabelPosition) {
    tempWorldPos
      .copy(selectedFeatureLabelPosition)
      .applyMatrix4(planetSpin.matrixWorld);
    tempNormal.copy(tempWorldPos).normalize();
    if (tempNormal.dot(tempCamDir) > 0.18) {
      tempWorldPos.project(camera);
      const x = (tempWorldPos.x * 0.5 + 0.5) * width;
      const y = (-tempWorldPos.y * 0.5 + 0.5) * height;
      occupied.push({
        left: x,
        right:
          x + Math.min(230, selectedFeatureTag.textContent.length * 6 + 18),
        top: y - 10,
        bottom: y + 10,
      });
    }
  }

  const positions = featurePointCloud.geometry.attributes.position;
  const candidates = [];
  for (let index = 0; index < marsFeatures.length; index += 1) {
    const feature = marsFeatures[index];
    if (CURATED_REGION_NAMES.has(feature.name.toLowerCase())) continue;

    tempWorldPos
      .set(positions.getX(index), positions.getY(index), positions.getZ(index))
      .applyMatrix4(planetSpin.matrixWorld);
    tempNormal.copy(tempWorldPos).normalize();
    const facing = tempNormal.dot(tempCamDir);
    if (facing <= 0.18) continue;

    tempWorldPos.project(camera);
    const x = (tempWorldPos.x * 0.5 + 0.5) * width + 5;
    const y = (-tempWorldPos.y * 0.5 + 0.5) * height - 4;
    const labelWidth = Math.min(145, Math.max(38, feature.name.length * 6 + 8));
    if (x < 0 || x + labelWidth > width || y < 10 || y > height - 10) continue;

    candidates.push({
      feature,
      x,
      y,
      width: labelWidth,
      score:
        Math.hypot(x - width / 2, y - height / 2) -
        Math.sqrt(Math.max(0, feature.diameterKm || 0)) * 0.08,
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  const labelLimit = Math.max(0, 18 - occupied.length);
  let shown = 0;
  for (const candidate of candidates) {
    if (shown >= labelLimit) break;
    const rect = {
      left: candidate.x,
      right: candidate.x + candidate.width,
      top: candidate.y - 9,
      bottom: candidate.y + 9,
    };
    if (occupied.some((existing) => overlaps(existing, rect))) continue;
    occupied.push(rect);

    context.strokeText(candidate.feature.name, candidate.x, candidate.y, 145);
    context.fillText(candidate.feature.name, candidate.x, candidate.y, 145);
    shown += 1;
  }
  context.globalAlpha = 1;
}

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
raycaster.params.Points.threshold = 0.022;
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
  const terrainHit = raycaster.intersectObject(marsModel, true)[0];
  const featureHit = featurePointCloud
    ? raycaster.intersectObject(featurePointCloud, false)[0]
    : null;

  if (
    featureHit &&
    (!terrainHit || featureHit.distance <= terrainHit.distance + 0.045)
  ) {
    const feature = marsFeatures[featureHit.index];
    if (feature) {
      userInteracted = true;
      handleMapLocationSelection(feature.lat, feature.lon, feature.name, {
        flyTo: true,
      });
      handleRoutePointSelection(feature.lat, feature.lon);
      return;
    }
  }

  if (terrainHit) {
    userInteracted = true;
    const localPoint = planetSpin.worldToLocal(terrainHit.point.clone());
    const normal = localPoint.clone().normalize();
    const lat = THREE.MathUtils.radToDeg(Math.asin(normal.y));
    let lon =
      THREE.MathUtils.radToDeg(Math.atan2(normal.x, normal.z)) + LON_OFFSET;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    handleMapLocationSelection(
      lat,
      lon,
      "Sector " + lat.toFixed(1) + "°, " + lon.toFixed(1) + "°",
      { flyTo: true },
    );
    handleRoutePointSelection(lat, lon);

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
  if (selectedFeatureLabelPosition) {
    tempWorldPos
      .copy(selectedFeatureLabelPosition)
      .applyMatrix4(planetSpin.matrixWorld);
    tempNormal.copy(tempWorldPos).normalize();
    const dot = tempNormal.dot(tempCamDir);
    if (dot > 0.18) {
      tempWorldPos.project(camera);
      const x = (tempWorldPos.x * 0.5 + 0.5) * w;
      const y = (-tempWorldPos.y * 0.5 + 0.5) * h;
      selectedFeatureLabel.style.transform =
        "translate3d(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px, 0)";
      selectedFeatureLabel.style.opacity = Math.min(
        1,
        (dot - 0.18) * 3.5,
      ).toFixed(2);
    } else {
      selectedFeatureLabel.style.opacity = "0";
    }
  } else {
    selectedFeatureLabel.style.opacity = "0";
  }
}

// UI Layer & Zoom Controls
layerSelectEl.addEventListener("change", (e) => {
  currentState.layer = e.target.value;
  setMapLayer(currentState.layer);
});

document.querySelector("#zoom-in").addEventListener("click", () => {
  if (currentState.zoom < 18) {
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
  renderFrontSideFeatureNames3D(performance.now());
  renderer.render(scene, camera);
}
loadMarsFeatureLocations();
requestAnimationFrame(animate);

// Sidebar navigation switches views while retaining the existing live map instances.
const workspace = document.querySelector('#workspace-layout');
const navItems = [...document.querySelectorAll('.nav-item[data-view]')];
const missionPanel = document.querySelector('#mission-panel');
const assistantPanel = document.querySelector('#assistant-panel');
const arPanel = document.querySelector('#ar-panel');

function showMarsView(view) {
  if (view !== "route" && routeSelectionActive) {
    routeSelectionActive = false;
    routeSelectionTarget = null;
    document.querySelectorAll("[data-route-pick]").forEach((button) => button.classList.remove("is-picking"));
  }
  workspace.dataset.view = view;
  navItems.forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle('is-active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  missionPanel.hidden = view !== 'mission';
  routePanel.hidden = view !== 'route';
  assistantPanel.hidden = view !== 'ai-help';
  arPanel.hidden = view !== 'ar-engine';
  requestAnimationFrame(() => {
    mars2DMap.invalidateSize({ pan: false });
    resizeScene();
  });
}

navItems.forEach((item) => item.addEventListener('click', () => {
  showMarsView(item.dataset.view);
}));
document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => {
  const target = navItems.find((item) => item.dataset.view === button.dataset.openView);
  if (target) target.click();
}));

const sidebarToggle = document.querySelector('#sidebar-toggle');
const appShell = document.querySelector('.app-shell');
sidebarToggle.addEventListener('click', () => {
  const opening = appShell.classList.toggle('sidebar-collapsed');
  const expanded = !opening;
  sidebarToggle.setAttribute('aria-expanded', String(expanded));
  sidebarToggle.setAttribute('aria-label', expanded ? 'Close sidebar' : 'Open sidebar');
  sidebarToggle.title = expanded ? 'Close sidebar' : 'Open sidebar';
  requestAnimationFrame(() => {
    mars2DMap.invalidateSize({ pan: false });
    resizeScene();
  });
});
// Global route endpoint UI: choose a side, then click either map or a catalog place.
document.querySelectorAll("[data-route-pick]").forEach((button) => {
  button.addEventListener("click", () => {
    routeSelectionTarget = button.dataset.routePick;
    routeSelectionActive = true;
    document.querySelectorAll("[data-route-pick]").forEach((item) => item.classList.toggle("is-picking", item === button));
    routeHintEl.textContent = "Choose the " + (routeSelectionTarget === "start" ? "start" : "destination") + " on the 2D map, 3D globe, or searchable place catalog.";
  });
});

routeStartLatInput.addEventListener("change", () => {
  if (routeStartLatInput.value !== "" && routeStartLonInput.value !== "") setRouteEndpoint("start", routeStartLatInput.value, routeStartLonInput.value);
});
routeStartLonInput.addEventListener("change", () => {
  if (routeStartLatInput.value !== "" && routeStartLonInput.value !== "") setRouteEndpoint("start", routeStartLatInput.value, routeStartLonInput.value);
});
routeEndLatInput.addEventListener("change", () => {
  if (routeEndLatInput.value !== "" && routeEndLonInput.value !== "") setRouteEndpoint("end", routeEndLatInput.value, routeEndLonInput.value);
});
routeEndLonInput.addEventListener("change", () => {
  if (routeEndLatInput.value !== "" && routeEndLonInput.value !== "") setRouteEndpoint("end", routeEndLatInput.value, routeEndLonInput.value);
});

routePlanButton.addEventListener("click", calculateMarsRoute);
document.querySelector("#clear-route-button").addEventListener("click", clearRoutePlan);
document.querySelector("#show-global-map").addEventListener("click", () => {
  currentState.zoom = 3;
  zoomLabelEl.textContent = "Z: 3";
  mars2DMap.setView([0, 0], 3);
});
initMissionPlanner({
  setEndpoint: setRouteEndpoint,
  renderRoute: renderMarsRoute,
  clearRoute: clearRoutePlan,
});
