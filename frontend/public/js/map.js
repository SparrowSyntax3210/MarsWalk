import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { initMissionPlanner } from "./mission-planner.js";

const canvas3D = document.querySelector("#mars-scene");
// The globe renders into its own stage inside the catalog column.
const containerBox = document.querySelector("#globe-stage");
const labels3DLayer = document.querySelector("#labels-3d-layer");
const regionListContainer = document.querySelector("#region-list-container");
const featuredSitesEl = document.querySelector("#featured-sites");
const featureTypeFilterEl = document.querySelector("#feature-type-filter");

const regionTitleEl = document.querySelector("#region-title");
const coordReadoutEl = document.querySelector("#coord-readout");
const pointStatusEl = document.querySelector("#point-status");
const pointStatusDot = document.querySelector("#point-status-dot");
const pointStatusDetail = document.querySelector("#point-status-detail");
const cursorReadoutEl = document.querySelector("#cursor-readout");
const layerChipsEl = document.querySelector("#layer-chips");
const layerManagerEl = document.querySelector("#layer-manager");
const layerManagerToggle = document.querySelector("#layer-manager-toggle");
const featureLabelsToggle = document.querySelector("#feature-labels-toggle");
const activeRegionNameEl = document.querySelector("#active-region-name");
const activeRegionCoordsEl = document.querySelector("#active-region-coords");
const info = {
  kicker: document.querySelector("#info-kicker"),
  title: document.querySelector("#info-title"),
  tags: document.querySelector("#info-tags"),
  coords: document.querySelector("#info-coords"),
  context: document.querySelector("#info-context"),
  mission: document.querySelector("#info-mission"),
  glance: document.querySelector("#info-glance"),
  sections: document.querySelector("#info-sections"),
  copy: document.querySelector("#info-copy"),
  routeStart: document.querySelector("#info-route-start"),
  routeEnd: document.querySelector("#info-route-end"),
  open3d: document.querySelector("#info-open-3d"),
};
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
// Curated field sites. Mission facts are fixed historical records
// (mission, agency, landing date); `summary` is a short plain-language note.
const MARS_REGIONS = [
  {
    name: "Jezero Crater",
    fullTitle: "Jezero Crater — Perseverance Delta",
    tagline: "Perseverance / delta geology",
    lat: 18.44,
    lon: 77.45,
    zoom: 10,
    mission: {
      name: "Mars 2020 · Perseverance + Ingenuity",
      agency: "NASA",
      landed: "18 Feb 2021",
    },
    summary:
      "An ancient lake basin with a well-preserved river delta. Perseverance is studying and caching rock cores here; the Ingenuity helicopter flew in this area from 2021 to 2024.",
    has3d: true,
  },
  {
    name: "Gale Crater",
    fullTitle: "Gale Crater — Curiosity Landing Site",
    tagline: "Curiosity traverse",
    lat: -5.4,
    lon: 137.8,
    zoom: 9,
    mission: {
      name: "Mars Science Laboratory · Curiosity",
      agency: "NASA",
      landed: "6 Aug 2012",
    },
    summary:
      "A 154 km crater with a central layered mound, Aeolis Mons (Mount Sharp). Curiosity found evidence of a long-lived ancient lake and habitable conditions.",
  },
  {
    name: "Meridiani Planum",
    fullTitle: "Meridiani Planum — Opportunity",
    tagline: "Opportunity field site",
    lat: -1.95,
    lon: -5.53,
    zoom: 9,
    mission: {
      name: "MER-B · Opportunity",
      agency: "NASA",
      landed: "25 Jan 2004",
      lastContact: "2018",
    },
    summary:
      'Flat plains rich in grey hematite. Opportunity found hematite spherules ("blueberries") and sulfate rocks that formed in past acidic water, driving over 45 km.',
  },
  {
    name: "Gusev Crater",
    fullTitle: "Gusev Crater — Spirit Rover Site",
    tagline: "Spirit field site",
    lat: -14.56,
    lon: 175.47,
    zoom: 9,
    mission: {
      name: "MER-A · Spirit",
      agency: "NASA",
      landed: "4 Jan 2004",
      lastContact: "2010",
    },
    summary:
      "A crater once thought to hold a lake. Spirit found volcanic plains and, near Home Plate, opaline silica pointing to past hot-spring or steam activity.",
  },
  {
    name: "Elysium Planitia",
    fullTitle: "Elysium Planitia — InSight Lander",
    tagline: "InSight seismic station",
    lat: 4.5,
    lon: 135.62,
    zoom: 9,
    mission: {
      name: "InSight",
      agency: "NASA",
      landed: "26 Nov 2018",
      lastContact: "2022",
    },
    summary:
      "Smooth volcanic plains chosen for a safe landing. InSight's seismometer recorded over 1,300 marsquakes and measured the size of Mars' core.",
  },
  {
    name: "Olympus Mons",
    fullTitle: "Olympus Mons — Shield Volcano",
    tagline: "Largest volcano known",
    lat: 18.65,
    lon: -133.8,
    zoom: 7,
    summary:
      "A shield volcano about 600 km across that rises roughly 22 km above the Mars datum, ringed by cliffs up to several kilometres high.",
  },
  {
    name: "Valles Marineris",
    fullTitle: "Valles Marineris — Candor Chasma",
    tagline: "Canyon system",
    lat: -6.5,
    lon: -70.8,
    zoom: 8,
    summary:
      "A canyon system over 4,000 km long and up to about 7 km deep. Candor Chasma holds thick layered deposits that record past water activity.",
  },
  {
    name: "Mawrth Vallis",
    fullTitle: "Mawrth Vallis — Exobiology Site",
    tagline: "Clay-rich channel",
    lat: 23.99,
    lon: -19.0,
    zoom: 9,
    summary:
      "An ancient outflow channel with some of the most extensive clay minerals on Mars. It was a finalist landing site for both Curiosity and ExoMars.",
  },
];

const CURATED_REGION_NAMES = new Set(
  MARS_REGIONS.map((region) => region.name.toLowerCase()),
);

let currentState = {
  lat: 18.44,
  lon: 77.45,
  zoom: 10,
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
let routeStartName = null;
let routeEndName = null;
let lastRoutePayload = null;
let routeFocusRegion = null; // region chosen in the route search card
let routeStatus = "draft"; // draft | calculating | calculated | stale | failed
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
        {
          maxNativeZoom: 18,
          maxZoom: 18,
          zoomOffset: -1,
          opacity: 1,
          className: "mars-warm-filter",
        },
      ),
      L.tileLayer(
        "https://trek.nasa.gov/tiles/Mars/EQ/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first_dd/1.0.0/default/default028mm/{z}/{y}/{x}.png",
        {
          maxNativeZoom: 18,
          maxZoom: 18,
          zoomOffset: -1,
          opacity: 1,
          className: "mars-warm-filter",
        },
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
const MARS_RADIUS_KM = 3389.5;
const PENDING = Symbol("pending");

// Small DOM builder. Text always goes through textContent, so values from
// external services (e.g. USGS unit descriptions) cannot inject markup.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  });
  children.flat().forEach((child) => {
    if (child === undefined || child === null || child === false) return;
    node.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  });
  return node;
}

function formatLatLon(lat, lon, digits = 3) {
  return `${Math.abs(lat).toFixed(digits)} ${lat >= 0 ? "N" : "S"} / ${Math.abs(lon).toFixed(digits)} ${lon >= 0 ? "E" : "W"}`;
}

function formatCoordinate(lat, lon) {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

function marsDistanceKm(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * r) / 2) ** 2 +
    Math.cos(aLat * r) *
      Math.cos(bLat * r) *
      Math.sin(((bLon - aLon) * r) / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(km) {
  return km < 1
    ? `${Math.round(km * 1000)} m`
    : km < 100
      ? `${km.toFixed(1)} km`
      : `${Math.round(km).toLocaleString()} km`;
}

function compassPoint(deg) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][
    Math.round((((deg % 360) + 360) % 360) / 45) % 8
  ];
}

function shortType(type) {
  return String(type || "Feature")
    .split(",")[0]
    .trim();
}

function zoomForFeature(feature) {
  const d = feature?.diameterKm || 0;
  if (d > 1000) return 4;
  if (d > 400) return 5;
  if (d > 150) return 7;
  if (d > 50) return 8;
  if (d > 15) return 9;
  return 10;
}

function findRegion(lat, lon, feature) {
  const byName =
    feature &&
    MARS_REGIONS.find(
      (region) => region.name.toLowerCase() === feature.name.toLowerCase(),
    );
  if (byName) return byName;
  return (
    MARS_REGIONS.find(
      (region) => marsDistanceKm(lat, lon, region.lat, region.lon) < 3,
    ) || null
  );
}

function findGazetteerFeature(name) {
  const key = name.toLowerCase();
  return (
    marsFeatures.find((feature) => feature.name.toLowerCase() === key) || null
  );
}

// Most specific named feature containing the point, else the closest one.
function nearestFeature(lat, lon) {
  let containing = null;
  let closest = null;
  for (const feature of marsFeatures) {
    const distanceKm = marsDistanceKm(lat, lon, feature.lat, feature.lon);
    const radius = (feature.diameterKm || 0) / 2;
    if (
      radius > 0 &&
      distanceKm <= radius &&
      (!containing || feature.diameterKm < containing.feature.diameterKm)
    ) {
      containing = { feature, distanceKm };
    }
    if (!closest || distanceKm < closest.distanceKm)
      closest = { feature, distanceKm };
  }
  if (containing) return { ...containing, inside: true };
  return closest ? { ...closest, inside: false } : null;
}

// Plain-language bands. Thresholds are common rules of thumb, shown as context only.
function slopeClass(deg) {
  if (deg < 5) return "Gentle";
  if (deg < 15) return "Moderate";
  if (deg < 25) return "Steep";
  return "Very steep";
}
function thermalInertiaClass(tiu) {
  if (tiu < 150) return "Dust-dominated surface";
  if (tiu < 400) return "Sand or mixed fines";
  if (tiu < 700) return "Coarse, crusted or rocky";
  return "Rock-dominated";
}
function dustOpacityClass(tau) {
  if (tau < 0.5) return "Clear sky";
  if (tau < 1) return "Hazy";
  if (tau < 2) return "Dusty";
  return "Dust-storm level";
}
const kelvinToC = (k) => k - 273.15;
const isNum = (value) => typeof value === "number" && Number.isFinite(value);

// The selection currently shown in the info panel.
let selection = null;

function pointLayer(id) {
  const point = selection?.point;
  if (point === PENDING) return PENDING;
  if (!point || point.error) return null;
  return point.layers?.find((layer) => layer.id === id) || null;
}

function cellValue(key) {
  const cell = selection?.cell;
  if (cell === PENDING) return PENDING;
  if (!cell || cell.error) return null;
  const value = cell.cell?.[key];
  return value === undefined ? null : value;
}

// value: PENDING | null | display string
function infoRow(label, value, note) {
  const strong =
    value === PENDING
      ? el("strong", { className: "is-pending", text: "Loading…" })
      : value === null || value === undefined || value === ""
        ? el("strong", { className: "is-missing", text: "No data" })
        : el("strong", { text: value });
  return el(
    "div",
    { className: "info-row" },
    el("span", { text: label }),
    strong,
    note ? el("small", { text: note }) : null,
  );
}

function fmt(value, digits, unit = "") {
  if (value === PENDING) return PENDING;
  if (!isNum(value)) return null;
  const number = value.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
  return unit === "°" ? `${number}°` : `${number}${unit ? ` ${unit}` : ""}`;
}

function layerValue(id, digits, unit) {
  const layer = pointLayer(id);
  if (layer === PENDING) return PENDING;
  if (!layer || layer.status !== "available") return null;
  return isNum(layer.value)
    ? fmt(layer.value, digits, unit)
    : layer.value || null;
}

function infoSection(title, rows, { open = false, footnote } = {}) {
  const details = el(
    "details",
    { className: "info-section", open },
    el("summary", { text: title }),
    el("div", { className: "info-rows" }, rows),
  );
  if (footnote)
    details.append(el("p", { className: "info-footnote", text: footnote }));
  return details;
}

function glanceCard(label, value, sub) {
  return el(
    "div",
    { className: "glance-card" },
    el("span", { text: label }),
    value === PENDING
      ? el("strong", { className: "is-pending", text: "…" })
      : el("strong", {
          className: value ? "" : "is-missing",
          text: value || "—",
        }),
    el("small", { text: value === PENDING ? "Loading" : sub || "" }),
  );
}

function renderSelectionHeader() {
  const { lat, lon, title, feature, region, nearest } = selection;
  info.kicker.textContent = region
    ? "FEATURED FIELD SITE"
    : feature
      ? "NAMED FEATURE"
      : "SELECTED COORDINATE";
  info.title.textContent = title;
  info.coords.textContent = formatCoordinate(lat, lon);

  const tags = [];
  if (feature)
    tags.push(
      el("span", { className: "info-tag", text: shortType(feature.type) }),
    );
  if (feature?.diameterKm)
    tags.push(
      el("span", {
        className: "info-tag",
        text: `${formatDistance(feature.diameterKm)} across`,
      }),
    );
  if (region?.mission)
    tags.push(
      el("span", { className: "info-tag is-mission", text: "Landing site" }),
    );
  if (feature?.url) {
    tags.push(
      el("a", {
        className: "info-tag is-link",
        href: feature.url.replace(/^http:/, "https:"),
        target: "_blank",
        rel: "noreferrer",
        text: "IAU record ↗",
      }),
    );
  }
  info.tags.replaceChildren(...tags);

  if (!feature && nearest) {
    const name = nearest.feature.name;
    info.context.textContent = nearest.inside
      ? `Inside ${name} (${shortType(nearest.feature.type).toLowerCase()}), ${formatDistance(nearest.distanceKm)} from its center.`
      : `Nearest named feature: ${name}, ${formatDistance(nearest.distanceKm)} away.`;
  } else {
    info.context.textContent = "";
  }

  if (region) {
    const facts = [];
    if (region.mission) {
      facts.push(
        infoRow("Mission", region.mission.name),
        infoRow("Agency", region.mission.agency),
        infoRow("Landed", region.mission.landed),
      );
      if (region.mission.lastContact)
        facts.push(infoRow("Last contact", region.mission.lastContact));
    }
    info.mission.replaceChildren(
      el("p", { className: "info-summary", text: region.summary }),
      facts.length ? el("div", { className: "info-rows" }, facts) : null,
    );
    info.mission.hidden = false;
  } else {
    info.mission.hidden = true;
    info.mission.replaceChildren();
  }

  const nearJezero = marsDistanceKm(lat, lon, 18.44, 77.45) < 40;
  info.open3d.hidden = !(region?.has3d || nearJezero);
}

function renderSelectionData() {
  const elevation = (() => {
    const layer = pointLayer("elevation");
    if (layer === PENDING) return PENDING;
    if (layer?.status === "available" && isNum(layer.value)) return layer.value;
    const cellElevation = cellValue("elevation_m");
    return cellElevation === PENDING
      ? PENDING
      : isNum(cellElevation)
        ? cellElevation
        : null;
  })();
  const slope = (() => {
    const layer = pointLayer("slope");
    if (layer === PENDING) return PENDING;
    return layer?.status === "available" && isNum(layer.value)
      ? layer.value
      : null;
  })();
  const ti = cellValue("tes_ti_mean_tiu");
  const tsurf = cellValue("mcd_tsurf");

  info.glance.replaceChildren(
    glanceCard(
      "Elevation",
      elevation === PENDING
        ? PENDING
        : isNum(elevation)
          ? `${Math.round(elevation).toLocaleString()} m`
          : null,
      "vs. Mars datum",
    ),
    glanceCard(
      "Slope",
      slope === PENDING
        ? PENDING
        : isNum(slope)
          ? `${slope.toFixed(1)}°`
          : null,
      isNum(slope) ? slopeClass(slope) : "~200 m scale",
    ),
    glanceCard(
      "Thermal inertia",
      ti === PENDING ? PENDING : isNum(ti) ? `${Math.round(ti)} TIU` : null,
      isNum(ti) ? thermalInertiaClass(ti) : "TES",
    ),
    glanceCard(
      "Surface temp.",
      tsurf === PENDING
        ? PENDING
        : isNum(tsurf)
          ? `${Math.round(kelvinToC(tsurf))} °C`
          : null,
      "Climate model",
    ),
  );

  const aspectCell = cellValue("aspect_deg");
  const terrain = infoSection(
    "Terrain",
    [
      infoRow(
        "Elevation · ~200 m grid",
        layerValue("elevation", 0, "m"),
        "Esri OnMars MDEM200M",
      ),
      infoRow("Elevation · 1 km cell", fmt(cellValue("elevation_m"), 0, "m")),
      infoRow("Slope · ~200 m", layerValue("slope", 1, "°")),
      infoRow(
        "Slope · 1 km cell",
        (() => {
          const deg = cellValue("slope_deg");
          const grade = cellValue("slope_grade_pct");
          if (deg === PENDING) return PENDING;
          return isNum(deg)
            ? `${deg.toFixed(1)}° · ${isNum(grade) ? grade.toFixed(1) : "—"}% grade`
            : null;
        })(),
      ),
      infoRow(
        "Faces (downslope)",
        aspectCell === PENDING
          ? PENDING
          : isNum(aspectCell)
            ? `${compassPoint(aspectCell)} · ${Math.round(aspectCell)}°`
            : null,
      ),
      infoRow(
        "Local relief · 3×3 km",
        fmt(cellValue("roughness_3x3_range_m"), 0, "m"),
        "Max minus min elevation in the surrounding cells",
      ),
      infoRow(
        "Elevation variation · ~200 m",
        layerValue("roughness", 1, "m RMS"),
      ),
    ],
    { open: true },
  );

  const duneHit = cellValue("dune_hit");
  const duneDistance = cellValue("dune_distance_km");
  const craterEdge = cellValue("crater_edge_distance_km");
  const craterId = cellValue("nearest_crater_id");
  const tiDay = cellValue("tes_ti_day_tiu");
  const tiNight = cellValue("tes_ti_night_tiu");
  const surface = infoSection(
    "Surface & hazards",
    [
      infoRow(
        "Thermal inertia (mean)",
        ti === PENDING
          ? PENDING
          : isNum(ti)
            ? `${Math.round(ti)} TIU · ${thermalInertiaClass(ti)}`
            : null,
        "Low = loose dust, high = rock or crust",
      ),
      infoRow(
        "Day / night",
        tiDay === PENDING
          ? PENDING
          : isNum(tiDay) || isNum(tiNight)
            ? `${isNum(tiDay) ? Math.round(tiDay) : "—"} / ${isNum(tiNight) ? Math.round(tiNight) : "—"} TIU`
            : null,
      ),
      infoRow(
        "Mapped dune field",
        duneHit === PENDING
          ? PENDING
          : duneHit === 1
            ? "Inside a mapped dune field"
            : isNum(duneDistance)
              ? `${formatDistance(duneDistance)} to nearest mapped dunes`
              : null,
        "MGD3 coverage is incomplete; absence is not proof",
      ),
      infoRow(
        "Nearest crater rim",
        craterEdge === PENDING
          ? PENDING
          : isNum(craterEdge)
            ? craterEdge === 0
              ? "Inside a catalogued crater"
              : formatDistance(craterEdge)
            : null,
        craterId && craterId !== PENDING
          ? `Robbins catalogue · ${craterId}`
          : "Robbins crater catalogue",
      ),
    ],
    { open: true },
  );

  const geologyLayer = pointLayer("regional-geology");
  const geologyCell =
    selection.cell && selection.cell !== PENDING && !selection.cell.error
      ? selection.cell.geology
      : null;
  const geologyValue =
    geologyLayer === PENDING
      ? PENDING
      : geologyLayer?.attributes
        ? `${geologyLayer.attributes.Unit || "—"} · ${geologyLayer.attributes.UnitDesc || ""}`.trim()
        : geologyCell
          ? `${geologyCell.code} · ${geologyCell.description}`
          : null;
  const geology = infoSection("Geology", [
    infoRow(
      "Mapped unit",
      geologyValue,
      "USGS SIM 3292 global map, 1:20M scale",
    ),
    infoRow(
      "Unit age",
      (() => {
        if (geologyValue === PENDING || !geologyValue) return geologyValue;
        const era = ["Amazonian", "Hesperian", "Noachian"].filter((name) =>
          geologyValue.includes(name),
        );
        return era.length ? era.join(" to ") : null;
      })(),
      "Amazonian < 3 Ga · Hesperian ~3–3.7 Ga · Noachian > 3.7 Ga",
    ),
  ]);

  const tau = cellValue("mcd_tau_pref_gcm");
  const wind = cellValue("mcd_wind_speed");
  const windTo = cellValue("mcd_wind_direction_to_deg");
  const vapour = cellValue("mcd_col_h2ovapor");
  const mcd =
    selection.cell && selection.cell !== PENDING && !selection.cell.error
      ? selection.cell.mcdContext
      : null;
  const climate = infoSection(
    "Climate (model)",
    [
      infoRow(
        "Surface temperature",
        tsurf === PENDING
          ? PENDING
          : isNum(tsurf)
            ? `${Math.round(kelvinToC(tsurf))} °C · ${Math.round(tsurf)} K`
            : null,
      ),
      infoRow(
        "Air temperature",
        (() => {
          const t = cellValue("mcd_temp");
          return t === PENDING
            ? PENDING
            : isNum(t)
              ? `${Math.round(kelvinToC(t))} °C`
              : null;
        })(),
      ),
      infoRow(
        "Surface pressure",
        fmt(cellValue("mcd_ps"), 0, "Pa"),
        "Earth sea level is about 101,325 Pa",
      ),
      infoRow(
        "Dust opacity (τ)",
        tau === PENDING
          ? PENDING
          : isNum(tau)
            ? `${tau.toFixed(2)} · ${dustOpacityClass(tau)}`
            : null,
      ),
      infoRow(
        "Wind",
        wind === PENDING
          ? PENDING
          : isNum(wind)
            ? `${wind.toFixed(1)} m/s${isNum(windTo) ? ` toward ${compassPoint(windTo)}` : ""}`
            : null,
      ),
      infoRow(
        "Water vapour column",
        vapour === PENDING
          ? PENDING
          : isNum(vapour)
            ? `${(vapour * 1000).toFixed(1)} pr-µm`
            : null,
      ),
    ],
    {
      footnote:
        mcd?.solarLongitudeDeg !== undefined && mcd?.solarLongitudeDeg !== null
          ? `Mars Climate Database climatology at Ls ${mcd.solarLongitudeDeg}°, ${mcd.localTimeHours} h local solar time. Coarse GCM grid; not a forecast or measurement.`
          : "Mars Climate Database climatology. Coarse model grid; not a forecast or measurement.",
    },
  );

  const sun = layerValue("solar-altitude", 1, "°");
  const sections = [terrain, surface, geology, climate];

  const remsRows = [
    "rems-air-temperature",
    "rems-ground-temperature",
    "rems-pressure",
    "rems-dust-opacity",
    "rems-uv",
    "rems-wind",
  ]
    .map((id) => pointLayer(id))
    .filter(
      (layer) => layer && layer !== PENDING && layer.status === "available",
    );
  if (remsRows.length) {
    sections.push(
      infoSection(
        "Curiosity weather station",
        remsRows.map((layer) =>
          infoRow(
            layer.name,
            isNum(layer.value)
              ? `${layer.value.toLocaleString()} ${layer.units || ""}`.trim()
              : String(layer.value),
          ),
        ),
        {
          open: true,
          footnote: remsRows[0].nominalResolution,
        },
      ),
    );
  }

  sections.push(
    infoSection("Sunlight", [
      infoRow(
        "Noon sun altitude",
        sun,
        "Equinox, level ground; ignores slope and shadows",
      ),
    ]),
  );

  const pending = pointLayer("elevation") === PENDING;
  const planned =
    pending || !selection.point || selection.point.error
      ? []
      : selection.point.layers.filter((layer) =>
          ["not-configured", "dataset-only", "map-only"].includes(layer.status),
        );
  if (planned.length) {
    sections.push(
      infoSection(
        "Not yet available here",
        planned.map((layer) =>
          infoRow(
            layer.name,
            layer.status === "map-only" ? "Map overlay only" : "Not connected",
            layer.source,
          ),
        ),
      ),
    );
  }

  const errors = [];
  if (selection.point?.error)
    errors.push(`Point service: ${selection.point.error}`);
  if (selection.cell?.error)
    errors.push(`Feature store: ${selection.cell.error}`);
  sections.push(
    infoSection(
      "Sources",
      [
        infoRow("Terrain", "MDEM200M + 1 km feature store"),
        infoRow("Surface", "MGS TES · MGD3 dunes · Robbins craters"),
        infoRow("Geology", "USGS SIM 3292"),
        infoRow("Climate", "Mars Climate Database"),
        infoRow("Names", "USGS / IAU Gazetteer"),
      ],
      {
        footnote: errors.length
          ? `${errors.join(" · ")}. Missing values are not estimated.`
          : "Values come from different datasets with different resolutions. Nothing shown here is interpolated or estimated.",
      },
    ),
  );

  info.sections.replaceChildren(...sections);
}

function setPointStatus(state, text, detail) {
  pointStatusDot.className = `status-dot status-${state}`;
  pointStatusEl.textContent = text;
  pointStatusDetail.textContent = detail;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function syncCatalogActive() {
  document
    .querySelectorAll(".featured-site, .region-item")
    .forEach((button) => {
      const name = button.dataset.name;
      button.classList.toggle(
        "active",
        Boolean(
          name &&
          selection &&
          name === (selection.region?.name || selection.feature?.name),
        ),
      );
    });
}

async function updatePointData(lat, lon, titleText, options = {}) {
  const reqId = ++currentState.reqId;
  currentState.lat = lat;
  currentState.lon = lon;
  const feature = options.feature || null;
  const region = options.region || findRegion(lat, lon, feature);
  const nearest = feature || region ? null : nearestFeature(lat, lon);
  const title =
    region?.name ||
    feature?.name ||
    (nearest?.inside
      ? `In ${nearest.feature.name}`
      : titleText || "Selected coordinate");

  selection = {
    lat,
    lon,
    title,
    feature: feature || (region ? findGazetteerFeature(region.name) : null),
    region,
    nearest,
    point: PENDING,
    cell: PENDING,
  };

  regionTitleEl.textContent = region?.fullTitle || title;
  coordReadoutEl.textContent = formatLatLon(lat, lon);
  activeRegionNameEl.textContent = title;
  activeRegionCoordsEl.textContent = formatLatLon(lat, lon, 2);
  selectedPointMarker.setLatLng([lat, lon]);
  updateSelectedCoordinateMarker(lat, lon);
  updateSelectedFeatureLabel(lat, lon, feature || region ? title : null);
  faceGlobeToward(lon);
  if (options.flyTo)
    mars2DMap.flyTo([lat, lon], currentState.zoom, { duration: 1.1 });

  setPointStatus(
    "loading",
    "Loading point data",
    "Terrain, geology and climate records",
  );
  renderSelectionHeader();
  renderSelectionData();
  syncCatalogActive();

  const query = `lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const apply = (key) => (result) => {
    if (reqId !== currentState.reqId) return;
    selection[key] = result;
    renderSelectionData();
  };
  await Promise.all([
    fetchJson(`/api/point?${query}`).then(apply("point"), (error) =>
      apply("point")({ error: error.message }),
    ),
    fetchJson(`/api/cell?${query}`).then(apply("cell"), (error) =>
      apply("cell")({ error: error.message }),
    ),
  ]);
  if (reqId !== currentState.reqId) return;

  const pointOk = selection.point && !selection.point.error;
  const cellOk = selection.cell && !selection.cell.error;
  if (pointOk && cellOk)
    setPointStatus(
      "ok",
      "Point data ready",
      "Terrain, geology and climate records",
    );
  else if (pointOk || cellOk)
    setPointStatus(
      "partial",
      "Partial data",
      pointOk ? "Feature store unavailable here" : "Point service unavailable",
    );
  else setPointStatus("error", "Data unavailable", "Both data services failed");
}

function handleMapLocationSelection(lat, lon, name, options = {}) {
  // The details panel is Explore-only; Route Planning clicks set endpoints instead.
  if (document.getElementById("workspace-layout").dataset.view === "route")
    return;
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
  marker.position.copy(
    latLonToLocalVector3(lat, lon)
      .normalize()
      .multiplyScalar(GLOBE_RADIUS + 0.045),
  );
}

function disposePlannedGlobeRoute() {
  if (!plannedRouteGlobeLayer) return;
  planetSpin.remove(plannedRouteGlobeLayer);
  plannedRouteGlobeLayer.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    if (Array.isArray(object.material))
      object.material.forEach((material) => material.dispose());
    else object.material.dispose();
  });
  plannedRouteGlobeLayer = null;
}

function terrainClassColor(className) {
  return (
    {
      impassable: "#ff4358",
      high: "#ff873d",
      caution: "#ffd34f",
      safe: "#43d6a3",
      unknown: "#f1f3f5",
    }[className] || "#00e5ff"
  );
}
// Short human label for a route endpoint, from the gazetteer.
function describePlace(lat, lon) {
  const region = MARS_REGIONS.find(
    (item) => marsDistanceKm(lat, lon, item.lat, item.lon) < 3,
  );
  if (region) return region.name;
  // Prefer a relative label to the closest named feature ("8 km SE of Victoria"),
  // so two points inside one large plain still get distinct names.
  let closest = null;
  for (const feature of marsFeatures) {
    const distanceKm = marsDistanceKm(lat, lon, feature.lat, feature.lon);
    if (!closest || distanceKm < closest.distanceKm) closest = { feature, distanceKm };
  }
  if (closest && closest.distanceKm < 2) return closest.feature.name;
  if (closest && closest.distanceKm < 60) {
    const r = Math.PI / 180;
    const y = Math.sin((lon - closest.feature.lon) * r) * Math.cos(lat * r);
    const x = Math.cos(closest.feature.lat * r) * Math.sin(lat * r) -
      Math.sin(closest.feature.lat * r) * Math.cos(lat * r) * Math.cos((lon - closest.feature.lon) * r);
    const bearing = (Math.atan2(y, x) / r + 360) % 360;
    return `${Math.round(closest.distanceKm)} km ${compassPoint(bearing)} of ${closest.feature.name}`;
  }
  const nearest = nearestFeature(lat, lon);
  if (nearest?.inside) return `In ${nearest.feature.name}`;
  return "Custom point";
}

function setRouteEndpoint(which, lat, lon, name) {
  lastRoutePayload = null;
  if (routeStatus !== "calculating") routeStatus = "draft";
  if (plannedRouteLayer) {
    mars2DMap.removeLayer(plannedRouteLayer);
    plannedRouteLayer = null;
  }
  disposePlannedGlobeRoute();
  const point = { lat: Number(lat), lon: Number(lon) };
  if (
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    point.lat < -90 ||
    point.lat > 90 ||
    point.lon < -180 ||
    point.lon > 180
  ) {
    routeHintEl.textContent =
      "Enter a valid latitude (−90 to 90) and longitude (−180 to 180).";
    return false;
  }
  const isStart = which === "start";
  if (isStart) routeStart = point;
  else routeEnd = point;

  let marker = isStart ? routeStartMarker : routeEndMarker;
  const fillColor = isStart ? "#00d084" : "#ff5370";
  if (!marker) {
    marker = L.circleMarker([point.lat, point.lon], {
      pane: "mars-routes-pane",
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor,
      fillOpacity: 1,
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
  coordinateLabel.textContent = formatLatLon(point.lat, point.lon, 2);
  const placeName = name || describePlace(point.lat, point.lon);
  if (isStart) routeStartName = placeName;
  else routeEndName = placeName;
  const missionLat = document.querySelector(
    isStart ? "#mission-start-lat" : "#mission-end-lat",
  );
  const missionLon = document.querySelector(
    isStart ? "#mission-start-lon" : "#mission-end-lon",
  );
  if (missionLat) missionLat.value = point.lat.toFixed(4);
  if (missionLon) missionLon.value = point.lon.toFixed(4);
  routePlanButton.disabled = !(routeStart && routeEnd);
  routeHintEl.textContent =
    routeStart && routeEnd
      ? "Both endpoints set · choose a priority and calculate the route."
      : isStart
        ? "Start set · now click the map for the destination."
        : "Destination set · now set the start point.";
  renderRouteState();
  return true;
}

const currentView = () =>
  document.getElementById("workspace-layout").dataset.view;

function handleRoutePointSelection(lat, lon, name) {
  if (routeSelectionActive && routeSelectionTarget) {
    const selected = routeSelectionTarget;
    routeSelectionActive = false;
    routeSelectionTarget = null;
    document
      .querySelectorAll("[data-route-pick]")
      .forEach((button) => button.classList.remove("is-picking"));
    setRouteEndpoint(selected, lat, lon, name);
    return;
  }
  // In Route Planning, plain clicks fill the start first, then the destination.
  if (currentView() !== "route") return;
  if (!routeStart) setRouteEndpoint("start", lat, lon, name);
  else if (!routeEnd) setRouteEndpoint("end", lat, lon, name);
  else
    routeHintEl.textContent =
      "Both endpoints are set. Use “Pick on map” to move one, or clear them in Options.";
}

function clearRoutePlan() {
  routeSelectionActive = false;
  routeSelectionTarget = null;
  routeStart = null;
  routeEnd = null;
  [routeStartMarker, routeEndMarker].forEach((marker) => {
    if (marker) mars2DMap.removeLayer(marker);
  });
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
  [
    "#mission-start-lat",
    "#mission-start-lon",
    "#mission-end-lat",
    "#mission-end-lon",
  ].forEach((selector) => {
    const input = document.querySelector(selector);
    if (input) input.value = "";
  });
  startCoordinateLabel.textContent = "—";
  endCoordinateLabel.textContent = "—";
  routeStartName = null;
  routeEndName = null;
  lastRoutePayload = null;
  routeStatus = "draft";
  routePlanButton.disabled = true;
  document
    .querySelectorAll("[data-route-pick]")
    .forEach((button) => button.classList.remove("is-picking"));
  document.querySelector("#terrain-class-summary").textContent =
    "Route class counts appear after planning.";
  routeHintEl.textContent = "Click the map to set a start point.";
  renderRouteState();
}

function renderMarsRoute(payload) {
  if (plannedRouteLayer) mars2DMap.removeLayer(plannedRouteLayer);
  plannedRouteLayer = null;
  disposePlannedGlobeRoute();
  const snappedStart = payload.endpoints.start;
  const snappedEnd = payload.endpoints.end;
  setRouteEndpoint("start", snappedStart.lat, snappedStart.lon, routeStartName);
  setRouteEndpoint("end", snappedEnd.lat, snappedEnd.lon, routeEndName);
  const coordinates = payload.route.geometry.coordinates;
  const latLngs = coordinates.map(([routeLon, routeLat]) => [
    routeLat,
    routeLon,
  ]);
  const routeDetails = payload.route_cell_details || [];
  plannedRouteLayer = L.layerGroup().addTo(mars2DMap);
  for (let index = 0; index < latLngs.length - 1; index += 1) {
    const cellClass = routeDetails[index + 1]?.class || "unknown";
    L.polyline([latLngs[index], latLngs[index + 1]], {
      pane: "mars-routes-pane",
      color: terrainClassColor(cellClass),
      weight: 4,
      opacity: 0.97,
    }).addTo(plannedRouteLayer);
  }
  const terrainStatus = payload.terrain_data?.status;
  const maxRouteZoom =
    payload.terrain_data?.instrument === "HiRISE"
      ? 16
      : terrainStatus === "global_dem_window"
        ? 12
        : terrainStatus === "local_dtm"
          ? 14
          : 10;
  mars2DMap.fitBounds(L.latLngBounds(latLngs), {
    padding: [30, 30],
    maxZoom: maxRouteZoom,
  });

  const globePoints = coordinates.map(([routeLon, routeLat]) =>
    latLonToLocalVector3(routeLat, routeLon)
      .normalize()
      .multiplyScalar(GLOBE_RADIUS + 0.035),
  );
  plannedRouteGlobeLayer = new THREE.Group();
  for (let index = 0; index < globePoints.length - 1; index += 1) {
    const cellClass = routeDetails[index + 1]?.class || "unknown";
    const segment = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.LineCurve3(globePoints[index], globePoints[index + 1]),
        1,
        0.006,
        6,
        false,
      ),
      new THREE.MeshBasicMaterial({ color: terrainClassColor(cellClass) }),
    );
    plannedRouteGlobeLayer.add(segment);
  }
  planetSpin.add(plannedRouteGlobeLayer);

  const classCounts = payload.terrain_assessment?.class_counts_on_route || {};
  document.querySelector("#terrain-class-summary").textContent =
    "Route cells: " +
    (classCounts.safe || 0) +
    " safe · " +
    (classCounts.caution || 0) +
    " caution · " +
    (classCounts.high || 0) +
    " high · impassable cells are avoided.";
  const metrics = payload.metrics;
  const terrainSource = ["local_dtm", "global_dem_window"].includes(
    terrainStatus,
  )
    ? payload.terrain_data.instrument +
      " · " +
      payload.terrain_data.native_posting_m +
      " m posting · " +
      payload.terrain_data.route_grid_m +
      " m route grid"
    : "global Parquet terrain fallback";
  const fallbackWarning = payload.terrain_data?.fallback_reason
    ? " · CAUTION: higher-resolution terrain rejected an endpoint; coarser fallback used"
    : "";
  const visionNote = payload.vision_model?.requested
    ? payload.vision_model?.status?.startsWith("used_")
      ? " · experimental vision cost · " +
        Math.round(
          (payload.vision_model.coverage_fraction_of_route_search_grid || 0) *
            100,
        ) +
        "% grid coverage"
      : " · vision layer unavailable for this route area"
    : "";
  routeHintEl.textContent =
    payload.mode +
    " route · " +
    metrics.distance_km +
    " km · max slope " +
    metrics.max_slope_deg +
    "° · " +
    terrainSource +
    " · snapped " +
    snappedStart.snap_distance_km +
    "/" +
    snappedEnd.snap_distance_km +
    " km" +
    fallbackWarning +
    visionNote +
    ".";
  lastRoutePayload = payload;
  routeStatus = "calculated";
  renderRouteState();
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
  document.querySelector("#terrain-class-summary").textContent =
    "Checking terrain and calculating a new route…";
  routePlanButton.disabled = true;
  routePlanButton.textContent = "Calculating…";
  routeHintEl.textContent =
    "Checking local HiRISE/CTX stereo DTM coverage, then the global Parquet grid…";
  lastRoutePayload = null;
  routeStatus = "calculating";
  renderRouteState();
  try {
    const response = await fetch("/api/route", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        start: routeStart,
        end: routeEnd,
        mode: routeModeSelect.value || "balanced",
        use_vision_model:
          options.useVision ?? Boolean(routeVisionToggle?.checked),
        vision_weight:
          (options.useVision ?? Boolean(routeVisionToggle?.checked)) ? 0.15 : 0,
        ...(Number.isFinite(options.maxSlope)
          ? { max_slope_deg: options.maxSlope }
          : {}),
      }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        payload.error || "Route calculation failed (" + response.status + ")",
      );
    if (plannedRouteLayer) mars2DMap.removeLayer(plannedRouteLayer);
    disposePlannedGlobeRoute();
    renderMarsRoute(payload);
    return payload;
  } catch (error) {
    routeHintEl.textContent = "Route unavailable: " + error.message;
    routeStatus = "failed";
    renderRouteState();
    return null;
  } finally {
    routePlanButton.disabled = !(routeStart && routeEnd);
    routePlanButton.textContent = lastRoutePayload
      ? "Recalculate route"
      : "Calculate route";
  }
}
mars2DMap.on("click", (event) => {
  const { lat, lng } = event.latlng;
  // Route Planning uses clicks for endpoints only; skip the point-data lookup.
  if (currentView() !== "route")
    handleMapLocationSelection(lat, lng, "Selected coordinate");
  handleRoutePointSelection(lat, lng);
});

// Live cursor coordinates and zoom readout.
mars2DMap.on("mousemove", (event) => {
  cursorReadoutEl.textContent =
    "CURSOR " + formatLatLon(event.latlng.lat, event.latlng.lng);
  cursorReadoutEl.classList.add("is-visible");
});
mars2DMap.on("mouseout", () => cursorReadoutEl.classList.remove("is-visible"));
mars2DMap.on("zoomend", () => {
  currentState.zoom = mars2DMap.getZoom();
  zoomLabelEl.textContent = "Z " + currentState.zoom;
});

// =========================================================================
// 5. SEARCHABLE LOCATION CATALOG
// =========================================================================
function selectRegion(region) {
  currentState.zoom = region.zoom || 9;
  handleMapLocationSelection(region.lat, region.lon, region.name, {
    region,
    flyTo: true,
  });
  handleRoutePointSelection(region.lat, region.lon, region.name);
}

function selectFeature(feature, { flyTo = true } = {}) {
  const region = findRegion(feature.lat, feature.lon, feature);
  if (flyTo) currentState.zoom = region?.zoom || zoomForFeature(feature);
  handleMapLocationSelection(feature.lat, feature.lon, feature.name, {
    feature,
    region,
    flyTo,
  });
  handleRoutePointSelection(feature.lat, feature.lon, feature.name);
}

function populateFeaturedSites() {
  featuredSitesEl.replaceChildren(
    ...MARS_REGIONS.map((region, index) => {
      const button = el(
        "button",
        {
          type: "button",
          className: "featured-site",
          "data-name": region.name,
          role: "listitem",
        },
        el(
          "strong",
          {},
          el("span", {
            className: "featured-index",
            text: String(index + 1).padStart(2, "0"),
          }),
          region.name,
        ),
        el("small", { text: region.tagline }),
      );
      button.addEventListener("click", () => {
        userInteracted = true;
        selectRegion(region);
      });
      return button;
    }),
  );
}

function populateLocationCatalog(features) {
  const catalog = [...features].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  // Type filter options, most common first.
  const typeCounts = new Map();
  catalog.forEach((feature) => {
    const type = shortType(feature.type);
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  });
  [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
      featureTypeFilterEl.append(
        el("option", {
          value: type,
          text: `${type} (${count.toLocaleString()})`,
        }),
      );
    });

  const fragment = document.createDocumentFragment();
  const entries = catalog.map((feature) => {
    const meta = [
      shortType(feature.type),
      feature.diameterKm ? formatDistance(feature.diameterKm) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const button = el(
      "button",
      {
        type: "button",
        className: "region-item",
        role: "option",
        "data-name": feature.name,
      },
      el("span", { text: feature.name }),
      el("small", { text: meta }),
    );
    button.addEventListener("click", () => selectFeature(feature));
    fragment.append(button);
    return {
      feature,
      button,
      name: feature.name.toLocaleLowerCase(),
      type: shortType(feature.type),
    };
  });

  const emptyMessage = el("p", {
    className: "location-empty",
    text: "No matching locations.",
    hidden: true,
  });
  fragment.append(emptyMessage);
  regionListContainer.replaceChildren(fragment);

  function filterLocations() {
    const query = locationSearchEl.value.trim().toLocaleLowerCase();
    const type = featureTypeFilterEl.value;
    let visible = 0;
    entries.forEach((entry) => {
      const matches =
        entry.name.includes(query) && (!type || entry.type === type);
      entry.button.hidden = !matches;
      if (matches) visible += 1;
    });
    // Featured sites stay visible unless the search clearly excludes them.
    featuredSitesEl.querySelectorAll(".featured-site").forEach((button) => {
      button.hidden =
        Boolean(query) &&
        !button.dataset.name.toLocaleLowerCase().includes(query);
    });
    emptyMessage.hidden = visible > 0;
    locationCountEl.textContent =
      query || type
        ? `${visible.toLocaleString()} of ${catalog.length.toLocaleString()} named surface features`
        : `${catalog.length.toLocaleString()} named surface features`;
  }

  locationSearchEl.value = "";
  locationSearchEl.addEventListener("input", filterLocations);
  featureTypeFilterEl.addEventListener("change", filterLocations);
  // Enter jumps to the first visible match.
  locationSearchEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const first = [
      ...featuredSitesEl.children,
      ...regionListContainer.children,
    ].find((node) => node.tagName === "BUTTON" && !node.hidden);
    if (first) first.click();
  });
  filterLocations();
  syncCatalogActive();
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
  const labelEl = el(
    "div",
    { className: "mars-3d-label" },
    el("span", { className: "dot" }),
    el("span", { className: "tag", text: reg.name }),
  );
  labelEl.addEventListener("click", (e) => {
    e.stopPropagation();
    userInteracted = true;
    selectRegion(reg);
  });
  labels3DLayer.appendChild(labelEl);
  labelItems3D.push({
    el: labelEl,
    name: reg.name,
    localPos: latLonToLocalVector3(reg.lat, reg.lon),
  });
});

let marsModel = null;
let hasLoaded = false;
let userInteracted = false;
let globeTargetRotation = null;

// Turn the globe so (lat, lon) faces the current camera direction.
function faceGlobeToward(lon) {
  const theta = THREE.MathUtils.degToRad(lon - LON_OFFSET);
  const cameraAzimuth = Math.atan2(camera.position.x, camera.position.z);
  let target = cameraAzimuth - theta;
  const turn = Math.PI * 2;
  target += Math.round((planetSpin.rotation.y - target) / turn) * turn;
  globeTargetRotation = target;
  userInteracted = true;
}

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
  if (!titleText) {
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
      // Small dots: 2,052 names on a ~250 px globe would otherwise hide the surface.
      size: 4.5,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.62,
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
    marker.bindTooltip(
      el("span", { text: `${feature.name} · ${shortType(feature.type)}` }),
      {
        direction: "top",
        offset: [0, -4],
        className: "mars-location-tooltip",
      },
    );
    marker.on("click", () => selectFeature(feature, { flyTo: false }));
    featureMarkerLayer.addLayer(marker);
  });

  featureLabelLayer = L.layerGroup().addTo(mars2DMap);
  mars2DMap.on("moveend", updateFeatureLabels);
  featureLabelsToggle.addEventListener("change", () => {
    if (featureLabelsToggle.checked) featureMarkerLayer.addTo(mars2DMap);
    else featureMarkerLayer.remove();
    updateFeatureLabels();
    renderLayerChips();
  });
  updateFeatureLabels();
}

// Permanent name labels are limited to features large enough for the
// current zoom, so the map stays readable and only ~60 labels exist at once.
let featureLabelLayer = null;
const MAX_MAP_LABELS = 60;
function minLabelDiameterKm(zoom) {
  if (zoom <= 3) return 500;
  if (zoom === 4) return 250;
  if (zoom === 5) return 120;
  if (zoom === 6) return 50;
  if (zoom === 7) return 20;
  if (zoom === 8) return 5;
  return 0;
}
function updateFeatureLabels() {
  if (!featureLabelLayer) return;
  featureLabelLayer.clearLayers();
  if (!featureLabelsToggle.checked) return;
  const bounds = mars2DMap.getBounds().pad(0.05);
  const minDiameter = minLabelDiameterKm(mars2DMap.getZoom());
  marsFeatures
    .filter(
      (feature) =>
        (feature.diameterKm || 0) >= minDiameter &&
        bounds.contains([feature.lat, feature.lon]),
    )
    .sort((a, b) => (b.diameterKm || 0) - (a.diameterKm || 0))
    .slice(0, MAX_MAP_LABELS)
    .forEach((feature) => {
      L.tooltip({
        permanent: true,
        direction: "right",
        offset: [6, 0],
        opacity: 0.92,
        interactive: false,
        className: "mars-location-name-label",
      })
        .setLatLng([feature.lat, feature.lon])
        .setContent(el("span", { text: feature.name }))
        .addTo(featureLabelLayer);
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
    populateRoutePlaceOptions();
    // The first selection may have rendered before names loaded; enrich it now.
    if (selection && !selection.feature) {
      if (selection.region)
        selection.feature = findGazetteerFeature(selection.region.name);
      else selection.nearest = nearestFeature(selection.lat, selection.lon);
      renderSelectionHeader();
      syncCatalogActive();
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
  // Small globes get fewer gazetteer names so the region labels stay readable.
  const labelBudget = width < 340 ? 6 : 18;
  const labelLimit = Math.max(0, labelBudget - occupied.length);
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
      selectFeature(feature);
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
    handleMapLocationSelection(lat, lon, "Selected coordinate", {
      flyTo: true,
    });
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

    tempWorldPos.project(camera);
    const x = (tempWorldPos.x * 0.5 + 0.5) * w;
    const y = (-tempWorldPos.y * 0.5 + 0.5) * h;
    // Hide labels that would be clipped by the edge of the globe stage.
    const fits = x > 8 && x < w - 8 * item.name.length && y > 10 && y < h - 10;
    if (dot > 0.18 && fits) {
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

// Visible-layer chips in the bottom HUD.
const LAYER_CHIPS = {
  HIRISE_AUTO: [
    ["HiRISE image", "#ff9d42"],
    ["CTX image", "#c75d28"],
  ],
  CTX_WARM: [
    ["CTX image", "#c75d28"],
    ["MDIM base", "#8c6a52"],
  ],
  CTX_RAW: [["CTX image · raw", "#b9b1a4"]],
  THEMIS_IR: [["THEMIS day IR", "#d9cbb8"]],
  MOLA_CLR: [["MOLA elevation", "#ffd34f"]],
  TES_THERMAL: [
    ["MDIM base", "#8c6a52"],
    ["TES thermal inertia", "#43d6a3"],
  ],
  TES_DUST: [
    ["MDIM base", "#8c6a52"],
    ["TES dust cover", "#ffd34f"],
  ],
  TES_CLAY: [
    ["MDIM base", "#8c6a52"],
    ["TES sheet silicates", "#c58cf0"],
  ],
  MOLA_ROUGHNESS: [
    ["MDIM base", "#8c6a52"],
    ["MOLA roughness", "#ff873d"],
  ],
  VIKING: [["Viking color mosaic", "#d98650"]],
};
function renderLayerChips() {
  const chips = [...(LAYER_CHIPS[currentState.layer] || [])];
  if (featureLabelsToggle.checked) chips.push(["Named features", "#fff4e8"]);
  chips.push(["Selected point", "#ff9d42"]);
  layerChipsEl.replaceChildren(
    ...chips.map(([label, color]) =>
      el(
        "span",
        { className: "layer-chip", style: `--chip:${color}` },
        el("i", { "aria-hidden": "true" }),
        label,
      ),
    ),
  );
}
layerSelectEl.addEventListener("change", renderLayerChips);
renderLayerChips();

layerManagerToggle.addEventListener("click", () => {
  const open = layerManagerEl.hidden;
  layerManagerEl.hidden = !open;
  layerManagerToggle.setAttribute("aria-expanded", String(open));
  layerManagerToggle.textContent = open ? "Close layers ×" : "Manage layers +";
});

// Info panel actions.
info.copy.addEventListener("click", async () => {
  if (!selection) return;
  const text = `${selection.lat.toFixed(5)}, ${selection.lon.toFixed(5)}`;
  try {
    await navigator.clipboard.writeText(text);
    info.copy.textContent = "Copied";
  } catch {
    info.copy.textContent = text;
  }
  setTimeout(() => {
    info.copy.textContent = "Copy coordinates";
  }, 1600);
});
[
  ["start", info.routeStart],
  ["end", info.routeEnd],
].forEach(([which, button]) => {
  button.addEventListener("click", () => {
    if (!selection) return;
    setRouteEndpoint(which, selection.lat, selection.lon);
    showMarsView("route");
  });
});

// Initial selection: Jezero, the first featured field site.
userInteracted = true;
populateFeaturedSites();
updatePointData(
  MARS_REGIONS[0].lat,
  MARS_REGIONS[0].lon,
  MARS_REGIONS[0].name,
  { region: MARS_REGIONS[0] },
);

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  if (globeTargetRotation !== null) {
    // Ease the globe so the selected point turns to face the camera.
    const diff = globeTargetRotation - planetSpin.rotation.y;
    planetSpin.rotation.y += diff * Math.min(1, delta * 4);
    if (Math.abs(diff) < 0.001) globeTargetRotation = null;
  } else if (hasLoaded && !document.hidden && !userInteracted) {
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
const workspace = document.querySelector("#workspace-layout");
const navItems = [...document.querySelectorAll(".nav-item[data-view]")];
const missionPanel = document.querySelector("#mission-panel");
const assistantPanel = document.querySelector("#assistant-panel");
const arPanel = document.querySelector("#ar-panel");

const VIEW_HEADLINES = {
  explore: "Choose a region. Read the ground.",
  route: "Compare options before committing.",
};

function showMarsView(view) {
  if (view !== "route" && routeSelectionActive) {
    routeSelectionActive = false;
    routeSelectionTarget = null;
    document
      .querySelectorAll("[data-route-pick]")
      .forEach((button) => button.classList.remove("is-picking"));
  }
  workspace.dataset.view = view;
  const navIndex = navItems.findIndex((item) => item.dataset.view === view);
  const navItem = navItems[navIndex];
  if (navItem) {
    document.querySelector("#view-kicker").textContent =
      `${String(navIndex + 1).padStart(2, "0")} / ${navItem.lastChild.textContent.trim().toUpperCase()}`;
    document.querySelector("#view-title").textContent =
      VIEW_HEADLINES[view] || navItem.dataset.title;
  }
  // The orange Explore selection marker would read as a third route point.
  mars2DMap.getPane("mars-selection-pane").style.display =
    view === "route" ? "none" : "";
  if (view === "route") renderRouteState();
  else restoreExploreSidebarCard();
  navItems.forEach((item) => {
    const active = item.dataset.view === view;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-current", active ? "page" : "false");
  });
  missionPanel.hidden = view !== "mission";
  routePanel.hidden = view !== "route";
  assistantPanel.hidden = view !== "ai-help";
  arPanel.hidden = view !== "ar-engine";
  requestAnimationFrame(() => {
    mars2DMap.invalidateSize({ pan: false });
    resizeScene();
  });
}

navItems.forEach((item) =>
  item.addEventListener("click", () => {
    showMarsView(item.dataset.view);
  }),
);
document.querySelectorAll("[data-open-view]").forEach((button) =>
  button.addEventListener("click", () => {
    const target = navItems.find(
      (item) => item.dataset.view === button.dataset.openView,
    );
    if (target) target.click();
  }),
);

const sidebarToggle = document.querySelector("#sidebar-toggle");
const appShell = document.querySelector(".app-shell");
sidebarToggle.addEventListener("click", () => {
  const opening = appShell.classList.toggle("sidebar-collapsed");
  const expanded = !opening;
  sidebarToggle.setAttribute("aria-expanded", String(expanded));
  sidebarToggle.setAttribute(
    "aria-label",
    expanded ? "Close sidebar" : "Open sidebar",
  );
  sidebarToggle.title = expanded ? "Close sidebar" : "Open sidebar";
  requestAnimationFrame(() => {
    mars2DMap.invalidateSize({ pan: false });
    resizeScene();
  });
});
// =========================================================================
// ROUTE PLANNING VIEW — builder panel, map HUD, sidebar route state
// =========================================================================
function rid(id) {
  return document.getElementById(id);
}

// Mirrors MODE_SETTINGS in adaptive_route_planner.py.
const ROUTE_MODES = {
  safest: {
    label: "Safest",
    note: "Slope limit 15° · strongest terrain-risk weight",
  },
  balanced: {
    label: "Balanced",
    note: "Slope limit 20° · moderate terrain-risk weight",
  },
  fastest: {
    label: "Fast",
    note: "Slope limit 25° · shortest path, low terrain-risk weight",
  },
};
const ROUTE_STATUS = {
  draft: { pill: "DRAFT", card: "Draft route", dot: "partial" },
  calculating: { pill: "CALCULATING", card: "Calculating…", dot: "loading" },
  calculated: { pill: "ROUTE CALCULATED", card: "Route calculated", dot: "ok" },
  stale: {
    pill: "NEEDS RECALCULATION",
    card: "Priority changed",
    dot: "partial",
  },
  failed: {
    pill: "ROUTE UNAVAILABLE",
    card: "Route unavailable",
    dot: "error",
  },
};

function formatDuration(hours) {
  if (!Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} m`;
  if (hours < 48) {
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    return minutes ? `${whole} h ${minutes} m` : `${whole} h`;
  }
  return `${Math.round(hours).toLocaleString()} h`;
}

function traverseAssumptions() {
  const speed = Number(rid("mission-speed")?.value);
  const hoursPerSol = Number(rid("mission-driving-hours")?.value);
  return {
    speed: Number.isFinite(speed) && speed > 0 ? speed : 0.15,
    hoursPerSol:
      Number.isFinite(hoursPerSol) && hoursPerSol > 0 ? hoursPerSol : 4,
  };
}

// Named gazetteer features whose center lies within 5 km of the route (or
// whose mapped radius the route crosses). Cached per payload.
function namedFeaturesNearRoute(payload) {
  if (payload.__nearby) return payload.__nearby;
  const coords = payload.route?.geometry?.coordinates || [];
  if (!coords.length || !marsFeatures.length) return [];
  const step = Math.max(1, Math.floor(coords.length / 400));
  const samples = coords.filter(
    (_, index) => index % step === 0 || index === coords.length - 1,
  );
  const lats = samples.map(([, lat]) => lat);
  const lons = samples.map(([lon]) => lon);
  const pad = 3;
  const box = {
    s: Math.min(...lats) - pad,
    n: Math.max(...lats) + pad,
    w: Math.min(...lons) - pad,
    e: Math.max(...lons) + pad,
  };
  const nearby = [];
  for (const feature of marsFeatures) {
    if (
      feature.lat < box.s ||
      feature.lat > box.n ||
      feature.lon < box.w ||
      feature.lon > box.e
    )
      continue;
    const reach = Math.max(5, (feature.diameterKm || 0) / 2);
    let closest = Infinity;
    for (const [lon, lat] of samples) {
      closest = Math.min(
        closest,
        marsDistanceKm(lat, lon, feature.lat, feature.lon),
      );
      if (closest <= reach) break;
    }
    if (closest <= reach) nearby.push(feature);
  }
  nearby.sort((a, b) => (a.diameterKm || 0) - (b.diameterKm || 0));
  payload.__nearby = nearby;
  return nearby;
}

function renderRouteState() {
  const payload = lastRoutePayload;
  const mode = rid("route-mode-select")?.value || "balanced";
  const status = ROUTE_STATUS[routeStatus] || ROUTE_STATUS.draft;
  const metrics = payload?.metrics;

  // Map HUD
  const regionSource = routeStart || routeEnd;
  const regionNearest = regionSource
    ? nearestFeature(regionSource.lat, regionSource.lon)
    : null;
  const regionName = regionSource
    ? MARS_REGIONS.find(
        (r) =>
          marsDistanceKm(regionSource.lat, regionSource.lon, r.lat, r.lon) < 60,
      )?.name || (regionNearest?.inside ? regionNearest.feature.name : "Mars")
    : routeFocusRegion || "Mars";
  rid("route-hud-kicker").textContent =
    `${regionName.toUpperCase()} / ROUTE WORKSPACE`;
  rid("route-hud-title").textContent = payload
    ? `${ROUTE_MODES[payload.mode]?.label || ROUTE_MODES[mode].label} traverse candidate`
    : routeStart && routeEnd
      ? `${ROUTE_MODES[mode].label} route · ready to calculate`
      : routeStart
        ? "Now choose a destination"
        : "Click the map to set a start point";
  const pill = rid("route-status-pill");
  pill.dataset.state = routeStatus;
  rid("route-status-text").textContent = status.pill;
  rid("route-hud-start").textContent = routeStartName || "Not set";
  rid("route-hud-end").textContent = routeEndName || "Not set";

  // Endpoint cards
  rid("start-name").textContent = routeStartName || "Not set";
  rid("end-name").textContent = routeEndName || "Not set";
  document
    .querySelector('[data-endpoint-card="start"]')
    .classList.toggle("is-set", Boolean(routeStart));
  document
    .querySelector('[data-endpoint-card="end"]')
    .classList.toggle("is-set", Boolean(routeEnd));

  // Candidate summary
  const nearby = payload ? namedFeaturesNearRoute(payload) : [];
  const counts = payload?.terrain_assessment?.class_counts_on_route || {};
  const { speed, hoursPerSol } = traverseAssumptions();
  const distance = metrics ? Number(metrics.distance_km) : NaN;
  const driveHours = distance / speed;
  rid("route-sum-distance").textContent = metrics
    ? `${distance.toFixed(distance < 10 ? 2 : 1)} km`
    : "—";
  rid("route-sum-slope").textContent = metrics
    ? `${Number(metrics.max_slope_deg).toFixed(1)}°`
    : "—";
  rid("route-sum-mean-slope").textContent =
    metrics && Number.isFinite(Number(metrics.mean_slope_deg))
      ? `${Number(metrics.mean_slope_deg).toFixed(1)}°`
      : "—";
  rid("route-sum-time").textContent = metrics
    ? `${formatDuration(driveHours)} · ${(driveHours / hoursPerSol).toFixed(1)} sols`
    : "—";
  const totalCells =
    (counts.safe || 0) +
    (counts.caution || 0) +
    (counts.high || 0) +
    (counts.unknown || 0);
  const pct = (key) =>
    totalCells ? Math.round(((counts[key] || 0) / totalCells) * 100) : 0;
  rid("route-sum-terrain").textContent =
    payload && totalCells
      ? ["safe", "caution", "high", "unknown"]
          .filter((key) => counts[key])
          .map((key) => `${pct(key)}% ${key}`)
          .join(" · ")
      : "—";
  rid("route-terrain-bar").replaceChildren(
    ...(payload && totalCells
      ? ["safe", "caution", "high", "unknown"]
          .filter((key) => counts[key])
          .map((key) =>
            el("i", {
              className: `bar-${key}`,
              style: `flex-grow:${counts[key]}`,
            }),
          )
      : []),
  );
  const featuresEl = rid("route-sum-features");
  featuresEl.textContent = payload
    ? `${nearby.length} ${nearby.length === 1 ? "feature" : "features"}`
    : "—";
  featuresEl.title = nearby
    .slice(0, 12)
    .map((feature) => feature.name)
    .join(", ");
  rid("route-summary-note").textContent = payload
    ? `Traverse time assumes ${speed} km/h and ${hoursPerSol} driving h/sol (edit in Mission Planner).${
        nearby.length
          ? ` Nearby: ${nearby
              .slice(0, 4)
              .map((f) => f.name)
              .join(", ")}${nearby.length > 4 ? "…" : ""}.`
          : ""
      }`
    : "Traverse time uses the Mission Planner speed and driving-hours inputs.";
  rid("route-hud-metric").textContent = payload
    ? `${distance.toFixed(distance < 10 ? 2 : 1)} km / max ${Number(metrics.max_slope_deg).toFixed(1)}° / ${nearby.length} named nearby`
    : routeStatus === "calculating"
      ? "Calculating…"
      : "No route yet";

  // Warn when the planner had to move an endpoint to reach passable terrain.
  const warningEl = rid("route-warning");
  const snaps = payload
    ? [
        ["start", payload.endpoints?.start],
        ["destination", payload.endpoints?.end],
      ]
    : [];
  const moved = snaps.filter(
    ([, point]) => Number(point?.snap_distance_km) > 0.5,
  );
  const warnings = [];
  if (payload && !(distance > 0)) {
    warnings.push(
      "Both endpoints snapped to the same passable terrain cell, so there is no traverse to show. Move the points apart or outside mapped crater and dune zones.",
    );
  } else if (moved.length) {
    warnings.push(
      `The ${moved.map(([label, point]) => `${label} moved ${Number(point.snap_distance_km).toFixed(1)} km`).join(" and ")} to the nearest passable cell.`,
    );
  }
  if (payload?.terrain_data?.fallback_reason)
    warnings.push(
      "Higher-resolution terrain rejected an endpoint; the coarse ~1 km global grid was used.",
    );
  warningEl.textContent = warnings.join(" ");
  warningEl.hidden = !warnings.length;

  rid("route-to-mission").disabled = !payload || !(distance > 0);
  if (routeStatus !== "calculating") {
    routePlanButton.textContent = payload
      ? "Recalculate route"
      : "Calculate route";
  }

  // Sidebar card shows the route state while this view is open.
  if (currentView() === "route") {
    rid("active-region-caption").textContent = "ROUTE STATE";
    activeRegionNameEl.textContent = status.card;
    activeRegionCoordsEl.textContent = routeStart
      ? `${formatLatLon(routeStart.lat, routeStart.lon, 1)}${routeEnd ? " →" : ""}`
      : "No endpoints yet";
    const dot = document.querySelector(".active-region-card .status-dot");
    if (dot) dot.className = `status-dot status-${status.dot}`;
  }
}

function restoreExploreSidebarCard() {
  rid("active-region-caption").textContent = "ACTIVE REGION";
  const dot = document.querySelector(".active-region-card .status-dot");
  if (dot) dot.className = "status-dot";
  if (selection) {
    activeRegionNameEl.textContent = selection.title;
    activeRegionCoordsEl.textContent = formatLatLon(
      selection.lat,
      selection.lon,
      2,
    );
  }
}

// Priority segmented control → hidden select read by calculateMarsRoute.
document.querySelectorAll('input[name="route-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    routeModeSelect.value = radio.value;
    rid("route-priority-note").textContent = ROUTE_MODES[radio.value].note;
    const missionPriority = rid("mission-priority");
    if (missionPriority) missionPriority.value = radio.value;
    if (lastRoutePayload && lastRoutePayload.mode !== radio.value) {
      routeStatus = "stale";
      routeHintEl.textContent = `Priority changed to ${ROUTE_MODES[radio.value].label}. Recalculate to compare.`;
    } else if (lastRoutePayload) {
      routeStatus = "calculated";
    }
    renderRouteState();
  });
});

// Named-place search for each endpoint.
function populateRoutePlaceOptions() {
  const names = new Set();
  const options = [];
  [...MARS_REGIONS, ...marsFeatures].forEach((place) => {
    const key = place.name.toLowerCase();
    if (names.has(key)) return;
    names.add(key);
    options.push(el("option", { value: place.name }));
  });
  rid("route-place-options").replaceChildren(...options);
}
function findPlaceByName(name) {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return (
    MARS_REGIONS.find((place) => place.name.toLowerCase() === key) ||
    marsFeatures.find((place) => place.name.toLowerCase() === key) ||
    null
  );
}
[
  ["start", "route-start-search"],
  ["end", "route-end-search"],
].forEach(([which, id]) => {
  const input = rid(id);
  const apply = () => {
    const place = findPlaceByName(input.value);
    if (!place) return;
    setRouteEndpoint(which, place.lat, place.lon, place.name);
    input.value = "";
    input.closest("details").open = false;
    if (routeStart && routeEnd) {
      mars2DMap.fitBounds(
        L.latLngBounds([
          [routeStart.lat, routeStart.lon],
          [routeEnd.lat, routeEnd.lon],
        ]),
        { padding: [80, 80], maxZoom: 12 },
      );
    }
  };
  input.addEventListener("change", apply);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") apply();
  });
});

rid("route-to-mission").addEventListener("click", () => {
  if (!lastRoutePayload) return;
  showMarsView("mission");
});

// -------------------------------------------------------------------------
// Route view region search: same catalog as Explore (featured sites + the
// USGS/IAU gazetteer), shown as a floating card on the route map.
// -------------------------------------------------------------------------
const ROUTE_REGION_LIMIT = 40;
const routeRegionInput = rid("route-region-input");
const routeRegionResults = rid("route-region-results");
const routeRegionNote = rid("route-region-note");
let routeRegionActiveIndex = -1;

function routeRegionMatches(query) {
  const key = query.trim().toLocaleLowerCase();
  if (!key) return MARS_REGIONS.map((region) => ({ place: region, region }));
  const seen = new Set();
  const ranked = [];
  const consider = (place, region) => {
    const name = place.name.toLocaleLowerCase();
    if (seen.has(name)) return;
    // A gazetteer entry for an already-listed featured site (e.g. "Gale") is a duplicate.
    if (region && place !== region && seen.has(region.name.toLocaleLowerCase())) return;
    const index = name.indexOf(key);
    if (index < 0) return;
    seen.add(name);
    // Featured sites first, then prefix matches, then other matches.
    ranked.push({ place, region, score: (region ? 0 : 2) + (index === 0 ? 0 : 1) });
  };
  MARS_REGIONS.forEach((region) => consider(region, region));
  marsFeatures.forEach((feature) => consider(feature, findRegion(feature.lat, feature.lon, feature)));
  ranked.sort((a, b) => a.score - b.score || a.place.name.localeCompare(b.place.name));
  return ranked;
}

function renderRouteRegionResults() {
  const query = routeRegionInput.value;
  const matches = routeRegionMatches(query);
  routeRegionActiveIndex = -1;
  const shown = matches.slice(0, ROUTE_REGION_LIMIT);
  const items = shown.map(({ place, region }, index) => {
    const meta = region?.tagline ||
      [shortType(place.type), place.diameterKm ? formatDistance(place.diameterKm) : null].filter(Boolean).join(" · ");
    const button = el("button", {
      type: "button",
      className: `route-region-item${routeFocusRegion === place.name ? " active" : ""}`,
      role: "option",
      id: `route-region-option-${index}`,
      "aria-selected": "false",
    },
    el("strong", {}, query.trim() ? null : el("span", { className: "featured-index", text: String(index + 1).padStart(2, "0") }), place.name),
    el("small", { text: meta }));
    button.addEventListener("click", () => chooseRouteRegion(place, region));
    return button;
  });
  if (!items.length) items.push(el("p", { className: "location-empty", text: "No matching regions." }));
  routeRegionResults.replaceChildren(
    el("div", { className: "catalog-group-title", text: query.trim() ? "MATCHING PLACES" : "FEATURED FIELD SITES" }),
    ...items,
  );
  routeRegionNote.textContent = query.trim()
    ? `${matches.length.toLocaleString()} match${matches.length === 1 ? "" : "es"}${matches.length > ROUTE_REGION_LIMIT ? ` · showing first ${ROUTE_REGION_LIMIT}` : ""}`
    : "Pick a region to fly there, then click the map to set endpoints.";
}

function chooseRouteRegion(place, region) {
  // While "Pick on map" is armed, a chosen place fills that endpoint instead.
  if (routeSelectionActive && routeSelectionTarget) {
    handleRoutePointSelection(place.lat, place.lon, place.name);
  } else {
    routeHintEl.textContent = routeStart
      ? `Showing ${place.name}. Use “Pick on map” to move an endpoint here.`
      : `Showing ${place.name}. Click the map to set the start point.`;
  }
  routeFocusRegion = place.name;
  mars2DMap.flyTo([place.lat, place.lon], region?.zoom || zoomForFeature(place), { duration: 1.1 });
  routeRegionInput.value = "";
  renderRouteRegionResults();
  renderRouteState();
}

function moveRouteRegionFocus(step) {
  const options = [...routeRegionResults.querySelectorAll(".route-region-item")];
  if (!options.length) return;
  routeRegionActiveIndex = (routeRegionActiveIndex + step + options.length) % options.length;
  options.forEach((option, index) => {
    const active = index === routeRegionActiveIndex;
    option.classList.toggle("is-focused", active);
    option.setAttribute("aria-selected", String(active));
  });
  options[routeRegionActiveIndex].scrollIntoView({ block: "nearest" });
  routeRegionInput.setAttribute("aria-activedescendant", options[routeRegionActiveIndex].id);
}

routeRegionInput.addEventListener("input", renderRouteRegionResults);
routeRegionInput.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); moveRouteRegionFocus(1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); moveRouteRegionFocus(-1); }
  else if (event.key === "Enter") {
    const options = [...routeRegionResults.querySelectorAll(".route-region-item")];
    (options[routeRegionActiveIndex] || options[0])?.click();
  } else if (event.key === "Escape") {
    routeRegionInput.value = "";
    renderRouteRegionResults();
  }
});
rid("route-region-toggle").addEventListener("click", (event) => {
  const toggle = event.currentTarget;
  const expanded = toggle.getAttribute("aria-expanded") === "true";
  toggle.setAttribute("aria-expanded", String(!expanded));
  toggle.setAttribute("aria-label", expanded ? "Expand region search" : "Collapse region search");
  toggle.textContent = expanded ? "+" : "−";
  rid("route-region-search").classList.toggle("is-collapsed", expanded);
});
renderRouteRegionResults();

// Global route endpoint UI: choose a side, then click either map or a catalog place.
document.querySelectorAll("[data-route-pick]").forEach((button) => {
  button.addEventListener("click", () => {
    routeSelectionTarget = button.dataset.routePick;
    routeSelectionActive = true;
    document
      .querySelectorAll("[data-route-pick]")
      .forEach((item) => item.classList.toggle("is-picking", item === button));
    routeHintEl.textContent =
      "Click the map to place the " +
      (routeSelectionTarget === "start" ? "start point." : "destination.");
  });
});

routeStartLatInput.addEventListener("change", () => {
  if (routeStartLatInput.value !== "" && routeStartLonInput.value !== "")
    setRouteEndpoint(
      "start",
      routeStartLatInput.value,
      routeStartLonInput.value,
    );
});
routeStartLonInput.addEventListener("change", () => {
  if (routeStartLatInput.value !== "" && routeStartLonInput.value !== "")
    setRouteEndpoint(
      "start",
      routeStartLatInput.value,
      routeStartLonInput.value,
    );
});
routeEndLatInput.addEventListener("change", () => {
  if (routeEndLatInput.value !== "" && routeEndLonInput.value !== "")
    setRouteEndpoint("end", routeEndLatInput.value, routeEndLonInput.value);
});
routeEndLonInput.addEventListener("change", () => {
  if (routeEndLatInput.value !== "" && routeEndLonInput.value !== "")
    setRouteEndpoint("end", routeEndLatInput.value, routeEndLonInput.value);
});

routePlanButton.addEventListener("click", calculateMarsRoute);
document
  .querySelector("#clear-route-button")
  .addEventListener("click", clearRoutePlan);
document.querySelector("#show-global-map").addEventListener("click", () => {
  mars2DMap.setView([0, 0], 3);
});
// Deep links: map.html#route, #mission, #ai-help, #ar-engine.
function openViewFromHash() {
  const view = location.hash.slice(1);
  if (navItems.some((item) => item.dataset.view === view)) showMarsView(view);
}
window.addEventListener("hashchange", openViewFromHash);
openViewFromHash();
initMissionPlanner({
  setEndpoint: setRouteEndpoint,
  renderRoute: renderMarsRoute,
  clearRoute: clearRoutePlan,
});
