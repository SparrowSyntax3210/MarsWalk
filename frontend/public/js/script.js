const marsRadius = 3396190;
const radiansToDegrees = 180 / Math.PI;

const regions = {
  jezero: {
    id: "jezero",
    title: "Jezero Crater",
    subtitle: "Final Jezero mosaic <span>·</span> 1 m / pixel output grid",
    credit: "MARS 2000 · FINAL JEZERO MOSAIC · TERRAIN: 20 M SOURCE DATA",
    tileUrl: "./tiles/jezero/{z}/{x}/{y}.jpg",
    tileFormat: "jpg",
    layerLabel: "Final Map · 1 m/pixel output grid",
    width: 31933,
    height: 30241,
    nativeZoom: 7,
    xMin: 4573663,
    yMax: 1109693.5,
    pixelSize: 1,
    hasTerrain: true,
  },
  gale: {
    id: "gale",
    title: "Gale Crater",
    subtitle: "CTX false-color <span>·</span> regional terrain + Curiosity science",
    credit: "CTX 5 M/PIXEL · MOLA TERRAIN ~463 M/PIXEL · PDS APXS / NASA TRAVERSE",
    tileUrl: "./tiles/gale/{z}/{x}/{y}.webp",
    tileFormat: "webp",
    layerLabel: "Gale CTX false-color view · ~5 m/pixel",
    width: 47420,
    height: 47420,
    nativeZoom: 8,
    xMin: 8061358.863169648,
    yMax: -237098.790093225,
    pixelSize: 4.9999744853063,
    hasTerrain: true,
    terrainResolutionLabel: "Terrain source grid ≈463 m/pixel (MOLA)",
  },
};

// Local map coordinates are raster pixels: x is column and y is row.
let nativeTileZoom = regions.jezero.nativeZoom;
const MarsRasterCRS = L.extend({}, L.CRS.Simple, {
  transformation: new L.Transformation(1, 0, 1, 0),
  scale(zoom) { return 2 ** (zoom - nativeTileZoom); },
  zoom(scale) { return Math.log2(scale) + nativeTileZoom; },
});

const map = L.map("map", {
  crs: MarsRasterCRS,
  minZoom: 0,
  maxZoom: nativeTileZoom,
  zoomSnap: 0.25,
  zoomDelta: 0.5,
  zoomControl: false,
  attributionControl: false,
  maxBoundsViscosity: 0.65,
});

const terrainFiles = {
  elevation: L.imageOverlay("./layers/jezero/elevation.png", L.latLngBounds(
    [1109693.5 - 1109700, 4573660 - 4573663],
    [1109693.5 - 1079440, 4605600 - 4573663],
  ), { opacity: 0.82 }),
  slope: L.imageOverlay("./layers/jezero/slope.png", L.latLngBounds(
    [1109693.5 - 1109700, 4573660 - 4573663],
    [1109693.5 - 1079440, 4605600 - 4573663],
  ), { opacity: 0.82 }),
  roughness: L.imageOverlay("./layers/jezero/roughness.png", L.latLngBounds(
    [1109693.5 - 1109700, 4573660 - 4573663],
    [1109693.5 - 1079440, 4605600 - 4573663],
  ), { opacity: 0.82 }),
  aspect: L.imageOverlay("./layers/jezero/aspect.png", L.latLngBounds(
    [1109693.5 - 1109700, 4573660 - 4573663],
    [1109693.5 - 1079440, 4605600 - 4573663],
  ), { opacity: 0.82 }),
};

const galeTerrainBounds = L.latLngBounds([0, 0], [regions.gale.height, regions.gale.width]);
const galeTerrainFiles = {
  elevation: L.imageOverlay("./layers/gale/elevation.png", galeTerrainBounds, { opacity: 0.82 }),
  slope: L.imageOverlay("./layers/gale/slope.png", galeTerrainBounds, { opacity: 0.82 }),
  roughness: L.imageOverlay("./layers/gale/roughness.png", galeTerrainBounds, { opacity: 0.82 }),
  aspect: L.imageOverlay("./layers/gale/aspect.png", galeTerrainBounds, { opacity: 0.82 }),
};
let galeScienceFeatures = [];
let galeScienceLayer = null;
let galeTraverseLayer = null;
let galeScienceReady = Promise.resolve();
let galeTerrainValues = null;
const galeTerrainGrid = {
  width: 512,
  height: 512,
  originX: 8061358.863169648,
  originY: -237098.790093225,
  pixelSizeX: (8298457.653 - 8061358.863169648) / 512,
  pixelSizeY: (-237098.790093225 - -474197.58018645) / 512,
};
const galeTerrainReady = fetch("./data/gale-terrain-values.f32")
  .then((response) => {
    if (!response.ok) throw new Error("Gale terrain sample grid could not be loaded.");
    return response.arrayBuffer();
  })
  .then((buffer) => { galeTerrainValues = new DataView(buffer); });

const loadingMessage = document.querySelector("#map-loading");
const loadingText = document.querySelector("#map-loading-text");
const coordinateText = document.querySelector("#coordinate-text");
const samplePopup = L.popup({ maxWidth: 320, className: "mars-sample-popup" });
const titleElement = document.querySelector("#region-title");
const subtitleElement = document.querySelector("#region-subtitle");
const creditElement = document.querySelector("#map-credit");
const regionButtons = [...document.querySelectorAll(".region-option")];

let currentRegion = regions.jezero;
let currentBounds = L.latLngBounds([0, 0], [currentRegion.height, currentRegion.width]);
let basemap = null;
let layerControl = null;
let hiriseLayer = null;
let footprintCollection = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatValue(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "No data";
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatDegrees(value, positiveDirection, negativeDirection) {
  return `${Math.abs(value).toFixed(4)}° ${value < 0 ? negativeDirection : positiveDirection}`;
}

function createLayerControl() {
  if (layerControl) map.removeControl(layerControl);
  const baseLayers = { [currentRegion.layerLabel]: basemap };
  const overlays = {};
  if (currentRegion.id === "jezero") {
    overlays["Elevation · 20 m"] = terrainFiles.elevation;
    overlays["Slope · 20 m"] = terrainFiles.slope;
    overlays["Roughness · 20 m"] = terrainFiles.roughness;
    overlays["Aspect · 20 m"] = terrainFiles.aspect;
    if (hiriseLayer) overlays["HiRISE observations · 7 footprints"] = hiriseLayer;
  } else if (currentRegion.id === "gale") {
    overlays["Elevation · MOLA ~463 m"] = galeTerrainFiles.elevation;
    overlays["Slope · MOLA ~463 m"] = galeTerrainFiles.slope;
    overlays["Roughness · MOLA ~463 m"] = galeTerrainFiles.roughness;
    overlays["Aspect · MOLA ~463 m"] = galeTerrainFiles.aspect;
    if (galeTraverseLayer) overlays["Curiosity traverse · NASA"] = galeTraverseLayer;
    if (galeScienceLayer) overlays["APXS target measurements · PDS"] = galeScienceLayer;
  }
  layerControl = L.control.layers(baseLayers, overlays, {
    collapsed: window.innerWidth < 620,
    position: "topright",
  }).addTo(map);
}

function fitCurrentMap() {
  map.invalidateSize({ pan: false });
  const fillZoom = map.getBoundsZoom(currentBounds, true);
  map.setView(currentBounds.getCenter(), Math.min(fillZoom, currentRegion.nativeZoom), { animate: false });
}

function activateRegion(regionId) {
  const nextRegion = regions[regionId];
  if (!nextRegion || nextRegion.id === currentRegion.id) return;

  samplePopup.remove();
  if (basemap && map.hasLayer(basemap)) map.removeLayer(basemap);
  if (hiriseLayer && map.hasLayer(hiriseLayer)) map.removeLayer(hiriseLayer);
  Object.values(terrainFiles).forEach((layer) => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  });
  Object.values(galeTerrainFiles).forEach((layer) => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  });
  [galeScienceLayer, galeTraverseLayer].forEach((layer) => {
    if (layer && map.hasLayer(layer)) map.removeLayer(layer);
  });
  if (layerControl) {
    map.removeControl(layerControl);
    layerControl = null;
  }

  currentRegion = nextRegion;
  nativeTileZoom = currentRegion.nativeZoom;
  currentBounds = L.latLngBounds([0, 0], [currentRegion.height, currentRegion.width]);
  map.setMaxZoom(currentRegion.nativeZoom);
  map.setMaxBounds(currentBounds);
  map.getContainer().setAttribute("aria-label", `Interactive map of ${currentRegion.title}`);
  document.title = `MarsWalk — ${currentRegion.title} Surface Map`;
  titleElement.textContent = currentRegion.title;
  subtitleElement.innerHTML = currentRegion.subtitle;
  creditElement.textContent = currentRegion.credit;
  coordinateText.textContent = "SELECT A LOCATION";
  loadingText.textContent = `Loading ${currentRegion.title} map…`;
  loadingMessage.classList.remove("is-hidden");
  regionButtons.forEach((button) => {
    const active = button.dataset.region === regionId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  basemap = L.tileLayer(currentRegion.tileUrl, {
    tileSize: 256,
    minZoom: 0,
    maxZoom: currentRegion.nativeZoom,
    minNativeZoom: 0,
    maxNativeZoom: currentRegion.nativeZoom,
    bounds: currentBounds,
    noWrap: true,
    keepBuffer: 3,
    updateWhenIdle: true,
  });
  basemap.once("tileload", () => loadingMessage.classList.add("is-hidden"));
  basemap.once("load", () => loadingMessage.classList.add("is-hidden"));
  basemap.on("tileerror", () => {
    if (currentRegion.id !== regionId) return;
    loadingText.textContent = `${currentRegion.title} map tiles did not load`;
    loadingMessage.classList.remove("is-hidden");
  });
  basemap.addTo(map);
  if (currentRegion.id === "gale" && galeTraverseLayer) galeTraverseLayer.addTo(map);
  createLayerControl();
  fitCurrentMap();
}

regionButtons.forEach((button) => {
  button.addEventListener("click", () => activateRegion(button.dataset.region));
});

function createBasemap(region) {
  return L.tileLayer(region.tileUrl, {
    tileSize: 256,
    minZoom: 0,
    maxZoom: region.nativeZoom,
    minNativeZoom: 0,
    maxNativeZoom: region.nativeZoom,
    bounds: currentBounds,
    noWrap: true,
    keepBuffer: 3,
    updateWhenIdle: true,
  });
}

basemap = createBasemap(currentRegion);
basemap.once("tileload", () => loadingMessage.classList.add("is-hidden"));
basemap.once("load", () => loadingMessage.classList.add("is-hidden"));
basemap.on("tileerror", () => {
  loadingText.textContent = `${currentRegion.title} map tiles did not load`;
  loadingMessage.classList.remove("is-hidden");
});
basemap.addTo(map);
createLayerControl();
fitCurrentMap();

map.on("click", async ({ latlng }) => {
  const column = Math.max(0, Math.min(currentRegion.width - 1, Math.floor(latlng.lng)));
  const row = Math.max(0, Math.min(currentRegion.height - 1, Math.floor(latlng.lat)));
  const easting = currentRegion.xMin + (column + 0.5) * currentRegion.pixelSize;
  const northing = currentRegion.yMax - (row + 0.5) * currentRegion.pixelSize;
  const longitude = (easting / marsRadius) * radiansToDegrees;
  // The source regional rasters use a Mars ocentric/equirectangular grid.
  const latitude = (northing / marsRadius) * radiansToDegrees;
  const coordinate = `${formatDegrees(latitude, "N", "S")} · ${formatDegrees(longitude, "E", "W")}`;
  coordinateText.textContent = coordinate;

  samplePopup.setLatLng(latlng).setContent(
    `<div class="sample-card"><div class="sample-kicker">${currentRegion.id.toUpperCase()} POINT QUERY</div>` +
    `<div class="sample-coordinates">${coordinate}</div>` +
    '<div class="sample-loading">Reading terrain rasters…</div></div>',
  ).openOn(map);

  const query = new URLSearchParams({ easting: easting.toFixed(2), northing: northing.toFixed(2) });
  try {
    let result;
    if (currentRegion.id === "gale") {
      await Promise.all([galeTerrainReady, galeScienceReady]);
      result = sampleGaleAt(easting, northing);
    } else {
      const response = await fetch(`/api/${currentRegion.id}/sample?${query}`);
      result = await response.json();
      if (!response.ok) throw new Error(result.error || "Terrain values are unavailable.");
    }
    const scienceHtml = currentRegion.id === "gale"
      ? renderGaleScience(result.science)
      : result.science.length
        ? '<div class="sample-science"><div class="sample-kicker">SCIENCE AT THIS POINT</div>' +
          result.science.map((item) => `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.id)} ↗</a>`).join("") +
          '</div>'
        : '<div class="sample-source">No selected HiRISE footprint covers this point. This does not mean the area has no other science data.</div>';
    samplePopup.setContent(
      `<div class="sample-card"><div class="sample-kicker">${currentRegion.id.toUpperCase()} POINT QUERY</div>` +
      `<div class="sample-coordinates">${coordinate}</div>` +
      '<div class="sample-grid">' +
      `<span>Elevation</span><strong>${formatValue(result.terrain.elevation_m)} m</strong>` +
      `<span>Slope</span><strong>${formatValue(result.terrain.slope_degrees)}°</strong>` +
      `<span>Roughness</span><strong>${formatValue(result.terrain.roughness_m)} m</strong>` +
      `<span>Aspect</span><strong>${formatValue(result.terrain.aspect_degrees)}°</strong>` +
      `</div>${scienceHtml}<div class="sample-source">${escapeHtml(result.terrainResolutionText || "Terrain values come from 20 m source rasters. The basemap uses a 1 m/pixel output grid.")}</div></div>`,
    );
  } catch (error) {
    samplePopup.setContent(
      `<div class="sample-card"><div class="sample-kicker">${currentRegion.id.toUpperCase()} POINT QUERY</div>` +
      `<div class="sample-coordinates">${coordinate}</div>` +
      `<div class="sample-error">${escapeHtml(error.message)}</div></div>`,
    );
  }
});

function sampleGaleAt(easting, northing) {
  const grid = galeTerrainGrid;
  const column = Math.max(0, Math.min(grid.width - 1, Math.floor((easting - grid.originX) / grid.pixelSizeX)));
  const row = Math.max(0, Math.min(grid.height - 1, Math.floor((grid.originY - northing) / grid.pixelSizeY)));
  const cell = row * grid.width + column;
  const readBand = (band) => {
    const value = galeTerrainValues.getFloat32((band * grid.width * grid.height + cell) * 4, true);
    return Number.isFinite(value) && Math.abs(value) < 9999 ? value : null;
  };
  const science = galeScienceFeatures.map((feature) => {
    const p = feature.properties || {};
    return { ...p, distance_m: Math.hypot(p.easting_m - easting, p.northing_m - northing) };
  }).filter((item) => item.distance_m <= 150)
    .sort((a, b) => a.distance_m - b.distance_m)
    .filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 3);
  return {
    terrain: {
      elevation_m: readBand(0), slope_degrees: readBand(1),
      roughness_m: readBand(2), aspect_degrees: readBand(3),
    },
    terrainResolutionText: "Terrain source grid ≈463 m/pixel (MOLA). Regional context only; not a meter-scale route safety assessment.",
    science,
  };
}

function renderGaleScience(items) {
  if (!items?.length) {
    return '<div class="sample-source">No APXS target measurement is recorded within 150 m of this click. APXS data are discrete observations; this does not mean the area lacks other science data.</div>';
  }
  const cards = items.slice(0, 3).map((item) => {
    const chemistry = item.chemistry || {};
    const composition = [
      ["SiO₂", chemistry.SiO2_pct], ["FeO", chemistry.FeO_pct],
      ["MgO", chemistry.MgO_pct], ["SO₃", chemistry.SO3_pct],
    ].filter(([, value]) => Number.isFinite(Number(value)))
      .map(([name, value]) => `${name} ${formatValue(value, 2)}%`).join(" · ");
    const strata = [item.stratigraphicFormation, item.stratigraphicMember]
      .filter(Boolean).map(escapeHtml).join(" · ");
    return `<div class="gale-science-result"><strong>${escapeHtml(item.target || item.id)}</strong>` +
      `<small>Sol ${escapeHtml(item.sol)} · ${formatValue(item.distance_m, 0)} m away${item.waypoint ? ` · ${escapeHtml(item.waypoint)}` : ""}</small>` +
      `${strata ? `<small>${strata}</small>` : ""}${composition ? `<small>${composition}</small>` : ""}` +
      `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open PDS APXS source ↗</a></div>`;
  }).join("");
  return `<div class="sample-science"><div class="sample-kicker">NEARBY CURIOSITY APXS DATA</div>${cards}</div>` +
    '<div class="sample-source">Discrete in-situ APXS targets; the latest included summary is through Sol 3712.</div>';
}

function toMapLatLng([longitude, latitude]) {
  const easting = marsRadius * (longitude / radiansToDegrees);
  const northing = marsRadius * (latitude / radiansToDegrees);
  return L.latLng(
    (regions.jezero.yMax - northing) / regions.jezero.pixelSize,
    (easting - regions.jezero.xMin) / regions.jezero.pixelSize,
  );
}

function observationPopup(feature) {
  const properties = feature.properties || {};
  const id = properties.id || "HiRISE observation";
  const href = `https://www.uahirise.org/${encodeURIComponent(id.replace(/_RED$/, ""))}`;
  const coverage = Number(properties.coverage_percent);
  const coverageText = Number.isFinite(coverage) ? `<p>${coverage.toFixed(1)}% AOI coverage estimate</p>` : "";
  return `<div class="sample-card"><div class="sample-kicker">HIRISE OBSERVATION FOOTPRINT</div>` +
    `<strong>${escapeHtml(id)}</strong>${coverageText}` +
    `<a href="${href}" target="_blank" rel="noopener noreferrer">Open observation details ↗</a></div>`;
}

fetch("./data/jezero-hirise-footprints.geojson")
  .then((response) => {
    if (!response.ok) throw new Error("HiRISE footprint data could not be loaded.");
    return response.json();
  })
  .then((collection) => {
    footprintCollection = collection;
    hiriseLayer = L.geoJSON(collection, {
      coordsToLatLng: toMapLatLng,
      style: { color: "#f4db9b", weight: 1, opacity: 0.95, fillColor: "#f4db9b", fillOpacity: 0.12 },
      onEachFeature(feature, layer) { layer.bindPopup(observationPopup(feature)); },
    });
    if (currentRegion.hasTerrain) createLayerControl();
  })
  .catch((error) => console.warn(error.message));

galeScienceReady = fetch("./data/gale-science.json")
  .then((response) => {
    if (!response.ok) throw new Error("Gale APXS target data could not be loaded.");
    return response.json();
  })
  .then((collection) => {
    galeScienceFeatures = collection.features || [];
    galeScienceLayer = L.geoJSON(collection, {
      coordsToLatLng: ([easting, northing]) => L.latLng(
        (regions.gale.yMax - northing) / regions.gale.pixelSize,
        (easting - regions.gale.xMin) / regions.gale.pixelSize,
      ),
      pointToLayer(_feature, latlng) {
        return L.circleMarker(latlng, {
          radius: 2.6, color: "#f5e2a4", weight: 1,
          fillColor: "#d28a62", fillOpacity: 0.9,
        });
      },
      onEachFeature(feature, layer) {
        const properties = feature.properties || {};
        layer.bindPopup(
          `<div class="sample-card"><div class="sample-kicker">CURIOSITY APXS TARGET · SOL ${escapeHtml(properties.sol)}</div>` +
          `<strong>${escapeHtml(properties.target || "APXS target")}</strong>` +
          `${properties.waypoint ? `<p>${escapeHtml(properties.waypoint)}</p>` : ""}` +
          `<a href="${escapeHtml(properties.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open PDS APXS record ↗</a></div>`,
        );
      },
    });
    if (currentRegion.id === "gale") createLayerControl();
  })
  .catch((error) => console.warn(error.message));

fetch("./data/gale-curiosity-traverse.geojson")
  .then((response) => {
    if (!response.ok) throw new Error("NASA Curiosity traverse geometry could not be loaded.");
    return response.json();
  })
  .then((collection) => {
    galeTraverseLayer = L.geoJSON(collection, {
      coordsToLatLng: (coordinate) => toMapLatLngForRegion(regions.gale, coordinate),
      style: { color: "#a9d8e9", weight: 2.4, opacity: 0.95 },
      onEachFeature(_feature, layer) {
        layer.bindPopup('<div class="sample-card"><div class="sample-kicker">CURIOSITY TRAVERSE</div><p>NASA Trek rover route geometry for Curiosity in Gale Crater.</p><a href="https://science.nasa.gov/mission/msl-curiosity/location-map/" target="_blank" rel="noopener noreferrer">NASA Curiosity location map ↗</a></div>');
      },
    });
    if (currentRegion.id === "gale") {
      galeTraverseLayer.addTo(map);
      createLayerControl();
    }
  })
  .catch((error) => console.warn(error.message));

function toMapLatLngForRegion(region, [longitude, latitude]) {
  const easting = marsRadius * (longitude / radiansToDegrees);
  const northing = marsRadius * (latitude / radiansToDegrees);
  return L.latLng(
    (region.yMax - northing) / region.pixelSize,
    (easting - region.xMin) / region.pixelSize,
  );
}

L.control.zoom({ position: "bottomright" }).addTo(map);
window.addEventListener("resize", fitCurrentMap);
