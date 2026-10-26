const ROUTE_MODES = ["safest", "balanced", "fastest"];
const MODE_TITLES = { safest: "Safest", balanced: "Balanced", fastest: "Fastest" };
const MARS_RADIUS_KM = 3396.19;

function numberValue(id) {
  return Number(document.querySelector(`#${id}`).value);
}

function readMissionInputs() {
  const start = { lat: numberValue("mission-start-lat"), lon: numberValue("mission-start-lon") };
  const end = { lat: numberValue("mission-end-lat"), lon: numberValue("mission-end-lon") };
  const values = {
    start,
    end,
    mode: document.querySelector("#mission-priority").value,
    profile: document.querySelector("#mission-profile").value,
    maxSlope: numberValue("mission-max-slope"),
    maxSols: numberValue("mission-max-sols"),
    maxDistanceKm: numberValue("mission-max-distance"),
    speedKmh: numberValue("mission-speed"),
    drivingHoursPerSol: numberValue("mission-driving-hours"),
    energyBudgetKwh: numberValue("mission-energy-budget"),
    energyKwhPerKm: numberValue("mission-energy-rate"),
    reservePct: numberValue("mission-energy-reserve"),
    roughnessLimitM: numberValue("mission-roughness-limit"),
    useVision: document.querySelector("#mission-use-vision").checked,
    crewSize: numberValue("mission-crew-size"),
    oxygenBudgetKg: numberValue("mission-oxygen-budget"),
    oxygenKgPerPersonSol: numberValue("mission-oxygen-rate"),
  };
  const entries = Object.entries({
    startLat: start.lat, startLon: start.lon, endLat: end.lat, endLon: end.lon,
    slopeLimit: values.maxSlope, missionSols: values.maxSols, distanceLimit: values.maxDistanceKm,
    speed: values.speedKmh, driveHours: values.drivingHoursPerSol,
    energyBudget: values.energyBudgetKwh, energyRate: values.energyKwhPerKm,
    reserve: values.reservePct, roughnessLimit: values.roughnessLimitM,
  });
  const invalid = entries.find(([, value]) => !Number.isFinite(value));
  if (invalid) throw new Error(`Enter a valid number for ${invalid[0]}.`);
  if (Math.abs(start.lat) > 90 || Math.abs(end.lat) > 90 || Math.abs(start.lon) > 180 || Math.abs(end.lon) > 180) {
    throw new Error("Coordinates must use latitude ±90° and longitude ±180°.");
  }
  if (values.start.lat === values.end.lat && values.start.lon === values.end.lon) {
    throw new Error("Start and destination must be different points.");
  }
  if (!(values.maxSlope > 0 && values.maxSlope <= 45)) throw new Error("Maximum slope must be above 0° and no more than 45°.");
  if (!(values.maxSols > 0 && values.maxDistanceKm > 0 && values.speedKmh > 0 && values.drivingHoursPerSol > 0)) throw new Error("Mission duration, distance limit, rover speed, and drive hours must be greater than zero.");
  if (values.energyBudgetKwh < 0 || values.energyKwhPerKm < 0 || values.reservePct < 0 || values.reservePct >= 100 || values.roughnessLimitM < 0) {
    throw new Error("Energy, reserve, and roughness values must be zero or positive; reserve must be under 100%.");
  }
  if (values.profile === "crewed" && (!(values.crewSize > 0) || values.oxygenBudgetKg < 0 || values.oxygenKgPerPersonSol < 0)) {
    throw new Error("Crew size must be positive and oxygen assumptions cannot be negative.");
  }
  return values;
}

function requestOptionsFor(mode, values) {
  return {
    start: values.start,
    end: values.end,
    mode,
    max_slope_deg: values.maxSlope,
    use_vision_model: values.useVision,
    vision_weight: values.useVision ? 0.15 : 0,
  };
}

async function requestRoute(mode, values) {
  const response = await fetch("/api/route", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(requestOptionsFor(mode, values)),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Route calculation failed (${response.status})`);
  return payload;
}

function makeEstimate(payload, values) {
  const metrics = payload.metrics;
  const distanceKm = Number(metrics.distance_km);
  const driveHours = distanceKm / values.speedKmh;
  const sols = driveHours / values.drivingHoursPerSol;
  const energyKwh = distanceKm * values.energyKwhPerKm;
  const availableEnergyKwh = values.energyBudgetKwh * (1 - values.reservePct / 100);
  const roughness = metrics.max_roughness_rms_m === null || metrics.max_roughness_rms_m === undefined
    ? Number.NaN : Number(metrics.max_roughness_rms_m);
  const reasons = [];
  if (metrics.max_slope_deg > values.maxSlope + 1e-6) reasons.push(`maximum slope ${metrics.max_slope_deg}° exceeds ${values.maxSlope}°`);
  if (distanceKm > values.maxDistanceKm) reasons.push(`route distance ${distanceKm.toFixed(1)} km exceeds ${values.maxDistanceKm} km entered`);
  if (Number.isFinite(roughness) && roughness > values.roughnessLimitM) reasons.push(`maximum roughness ${roughness} m exceeds the ${values.roughnessLimitM} m review limit`);
  if (sols > values.maxSols) reasons.push(`estimated drive schedule ${sols.toFixed(1)} sols exceeds ${values.maxSols} sols`);
  if (energyKwh > availableEnergyKwh) reasons.push(`estimated driving energy ${energyKwh.toFixed(1)} kWh exceeds the ${availableEnergyKwh.toFixed(1)} kWh budget after reserve`);
  const oxygenKg = values.profile === "crewed" ? sols * values.crewSize * values.oxygenKgPerPersonSol : null;
  if (oxygenKg !== null && oxygenKg > values.oxygenBudgetKg) reasons.push(`rough oxygen allowance ${oxygenKg.toFixed(1)} kg exceeds ${values.oxygenBudgetKg.toFixed(1)} kg entered`);
  const classCounts = payload.terrain_assessment?.class_counts_on_route || {};
  if ((classCounts.high || 0) > 0) reasons.push(`${classCounts.high} high-cost route cells need review`);
  return {
    mode: payload.mode || values.mode,
    payload,
    distanceKm,
    driveHours,
    sols,
    energyKwh,
    availableEnergyKwh,
    oxygenKg,
    roughness: Number.isFinite(roughness) ? roughness : null,
    reasons,
    status: reasons.length ? "review" : "within entered limits",
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderOptions(results, values, selectedMode, selectRoute) {
  const list = document.querySelector("#mission-option-list");
  list.replaceChildren();
  for (const result of results) {
    const card = element("article", `mission-option${result.estimate ? ` is-${result.estimate.status === "within entered limits" ? "within" : "review"}` : " is-unavailable"}`);
    const title = element("div", "mission-option-title");
    title.append(element("strong", "", MODE_TITLES[result.mode] || result.mode));
    title.append(element("span", "", result.estimate?.status || "Unavailable"));
    card.append(title);
    if (result.estimate) {
      const estimate = result.estimate;
      const details = element("div", "mission-option-metrics");
      details.append(element("span", "", `${estimate.distanceKm.toFixed(2)} km`));
      details.append(element("span", "", `${estimate.sols.toFixed(1)} sols*`));
      details.append(element("span", "", `${estimate.energyKwh.toFixed(1)} kWh*`));
      details.append(element("span", "", `slope ${estimate.payload.metrics.max_slope_deg}°`));
      card.append(details);
      if (estimate.reasons.length) card.append(element("small", "mission-option-note", estimate.reasons.join(" · ")));
      const button = element("button", "mission-select-route", result.mode === selectedMode ? "Show this route · selected" : "Show this route");
      button.type = "button";
      button.addEventListener("click", () => selectRoute(estimate));
      card.append(button);
    } else {
      card.append(element("small", "mission-option-note", result.error));
    }
    list.append(card);
  }
}

function buildReport(estimate, values) {
  return {
    title: "MarsWalk mission planning estimate",
    generated_at: new Date().toISOString(),
    status: estimate.status,
    inputs: {
      profile: values.profile,
      start_requested: values.start,
      destination_requested: values.end,
      route_priority: estimate.mode,
      max_slope_deg: values.maxSlope,
      maximum_mission_sols: values.maxSols,
      maximum_route_distance_km: values.maxDistanceKm,
      assumed_average_speed_kmh: values.speedKmh,
      assumed_driving_hours_per_sol: values.drivingHoursPerSol,
      energy_budget_kwh: values.energyBudgetKwh,
      energy_use_assumption_kwh_per_km: values.energyKwhPerKm,
      energy_reserve_percent: values.reservePct,
      roughness_review_limit_m_rms: values.roughnessLimitM,
      ...(values.profile === "crewed" ? { crew_size: values.crewSize, oxygen_budget_kg: values.oxygenBudgetKg, oxygen_assumption_kg_per_person_sol: values.oxygenKgPerPersonSol } : {}),
    },
    estimates: {
      distance_km: estimate.distanceKm,
      driving_hours: estimate.driveHours,
      sols: estimate.sols,
      energy_kwh: estimate.energyKwh,
      energy_available_after_reserve_kwh: estimate.availableEnergyKwh,
      oxygen_kg: estimate.oxygenKg,
      constraints_to_review: estimate.reasons,
    },
    route_metrics: estimate.payload.metrics,
    terrain_source: estimate.payload.terrain_data,
    route: estimate.payload.route,
    limitations: [
      "Travel time and energy are user-assumption calculations, not rover performance predictions.",
      "The oxygen figure is a user-configurable allowance and excludes EVA, habitat, contingency, and life-support system details.",
      "Radiation, wheel slip, dust events, day/night operations, and validated safety probability are not modeled.",
      "Route cost settings are terrain-planning proxies and are not rover-certified limits.",
    ],
  };
}

function renderSelectedSummary(estimate, values) {
  const summary = document.querySelector("#mission-selected-summary");
  const warnings = document.querySelector("#mission-warnings");
  summary.replaceChildren();
  warnings.replaceChildren();
  const title = element("h4", "", `${MODE_TITLES[estimate.mode]} route · ${estimate.status}`);
  summary.append(title);
  const grid = element("div", "mission-summary-grid");
  const entries = [
    ["Route distance", `${estimate.distanceKm.toFixed(2)} km`],
    ["Driving time*", `${estimate.driveHours.toFixed(1)} hours`],
    ["Schedule*", `${estimate.sols.toFixed(1)} sols`],
    ["Energy*", `${estimate.energyKwh.toFixed(1)} kWh`],
    ["Max slope", `${estimate.payload.metrics.max_slope_deg}°`],
    ["Max roughness", estimate.roughness === null ? "not reported" : `${estimate.roughness} m RMS`],
  ];
  if (estimate.oxygenKg !== null) entries.push(["O₂ allowance*", `${estimate.oxygenKg.toFixed(1)} kg`]);
  for (const [label, value] of entries) {
    const cell = element("div", "mission-summary-cell");
    cell.append(element("small", "", label), element("strong", "", value));
    grid.append(cell);
  }
  summary.append(grid);
  const counts = estimate.payload.terrain_assessment?.class_counts_on_route || {};
  const source = estimate.payload.terrain_data?.instrument
    ? `${estimate.payload.terrain_data.instrument} DTM · ${estimate.payload.terrain_data.route_grid_m} m route grid`
    : "Global Parquet terrain grid";
  summary.append(element("p", "mission-source-note", `Terrain: ${source}. Route cells: ${counts.safe || 0} safe, ${counts.caution || 0} caution, ${counts.high || 0} high. ${estimate.payload.vision_model?.requested ? `Vision layer: ${estimate.payload.vision_model.status}.` : "Vision layer off."}`));
  const notices = estimate.reasons.length ? estimate.reasons : ["No entered mission limit was exceeded by the returned route metrics."];
  notices.forEach((notice) => warnings.append(element("p", estimate.reasons.length ? "mission-warning" : "mission-ok", notice)));
  if (values.profile === "crewed") warnings.append(element("p", "mission-warning", "Oxygen is only a configurable allowance estimate; it is not a life-support model."));
}

function haversineKm(a, b) {
  const rad = (degrees) => degrees * Math.PI / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function readLineCoordinates(input) {
  const parsed = JSON.parse(input);
  const geometry = parsed.type === "Feature" ? parsed.geometry : parsed;
  if (geometry?.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    throw new Error("Provide a GeoJSON LineString with at least two [longitude, latitude] coordinates.");
  }
  return geometry.coordinates.map((point) => {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(Number(point[0])) || !Number.isFinite(Number(point[1])) || Math.abs(Number(point[1])) > 90 || Math.abs(Number(point[0])) > 180) {
      throw new Error("Each coordinate must be [longitude, latitude] within Mars latitude/longitude bounds.");
    }
    return [Number(point[0]), Number(point[1])];
  });
}

function sampleLine(points, maxSamples = 20) {
  const segments = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const length = haversineKm(points[i - 1], points[i]);
    segments.push({ start: points[i - 1], end: points[i], startDistance: total, length });
    total += length;
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error("The custom route must have positive length.");
  const count = Math.min(maxSamples, Math.max(2, Math.ceil(total / 2) + 1));
  return Array.from({ length: count }, (_, index) => {
    const target = total * index / (count - 1);
    const segment = segments.find((item) => target <= item.startDistance + item.length) || segments.at(-1);
    const fraction = segment.length > 0 ? (target - segment.startDistance) / segment.length : 0;
    return {
      lat: segment.start[1] + (segment.end[1] - segment.start[1]) * fraction,
      lon: segment.start[0] + (segment.end[0] - segment.start[0]) * fraction,
    };
  });
}

async function auditCustomRoute() {
  const output = document.querySelector("#mission-audit-result");
  const button = document.querySelector("#mission-audit-button");
  output.replaceChildren();
  try {
    const points = readLineCoordinates(document.querySelector("#mission-custom-route").value.trim());
    const samples = sampleLine(points);
    button.disabled = true;
    button.textContent = `Sampling ${samples.length} points…`;
    const responses = new Array(samples.length);
    let nextSample = 0;
    const workers = Array.from({ length: Math.min(4, samples.length) }, async () => {
      while (nextSample < samples.length) {
        const index = nextSample++;
        const query = new URLSearchParams({ lat: String(samples[index].lat), lon: String(samples[index].lon) });
        const response = await fetch(`/api/point?${query}`);
        if (!response.ok) throw new Error(`Terrain sample unavailable (${response.status})`);
        responses[index] = await response.json();
      }
    });
    await Promise.all(workers);
    const readLayer = (payload, id) => Number(payload.layers?.find((layer) => layer.id === id)?.value);
    const slopes = responses.map((item) => readLayer(item, "slope")).filter(Number.isFinite);
    const roughness = responses.map((item) => readLayer(item, "roughness")).filter(Number.isFinite);
    let lengthKm = 0;
    for (let i = 1; i < points.length; i += 1) lengthKm += haversineKm(points[i - 1], points[i]);
    const values = readMissionInputs();
    const estimate = makeEstimate({ metrics: {
      distance_km: lengthKm,
      max_slope_deg: slopes.length ? Math.max(...slopes) : null,
      max_roughness_rms_m: roughness.length ? Math.max(...roughness) : null,
    }, terrain_assessment: { class_counts_on_route: {} }, vision_model: { requested: false }, mode: "custom" }, values);
    const title = element("strong", "", `Custom traverse · ${lengthKm.toFixed(2)} km · ${samples.length} sampled locations`);
    output.append(title);
    output.append(element("p", "", `Sampled slope range: ${slopes.length ? `${Math.min(...slopes).toFixed(1)}°–${Math.max(...slopes).toFixed(1)}°` : "unavailable"}. Maximum sampled local elevation variation: ${roughness.length ? `${Math.max(...roughness).toFixed(1)} m` : "unavailable"}.`));
    output.append(element("p", "", `Entered-assumption estimate: ${estimate.driveHours.toFixed(1)} driving hours, ${estimate.sols.toFixed(1)} sols, ${estimate.energyKwh.toFixed(1)} kWh${estimate.oxygenKg === null ? "" : `, ${estimate.oxygenKg.toFixed(1)} kg O₂ allowance`}.`));
    estimate.reasons.forEach((reason) => output.append(element("p", "mission-warning", reason)));
    if (slopes.some((slope) => slope > values.maxSlope)) output.append(element("p", "mission-warning", `At least one sampled slope exceeds your ${values.maxSlope}° limit.`));
    if (roughness.some((value) => value > values.roughnessLimitM)) output.append(element("p", "mission-warning", `At least one sampled roughness value exceeds your ${values.roughnessLimitM} m review limit.`));
    output.append(element("p", "mission-audit-caveat", "Samples use the global Esri OnMars MDEM200M service at up to 20 points, approximately 2 km apart for shorter traverses. Gaps between samples, dune/crater hazards, local high-resolution DTM detail, and rover mobility are not assessed."));
  } catch (error) {
    output.append(element("p", "mission-warning", error.message));
  } finally {
    button.disabled = false;
    button.textContent = "Audit custom traverse";
  }
}

export function initMissionPlanner({ setEndpoint, renderRoute, clearRoute }) {
  let latestReport = null;
  const profile = document.querySelector("#mission-profile");
  const status = document.querySelector("#mission-status");
  const resultsPanel = document.querySelector("#mission-results");
  const planButton = document.querySelector("#mission-plan-button");
  const syncCoordinates = (which) => {
    const suffix = which === "start" ? "start" : "end";
    const lat = document.querySelector(`#mission-${suffix}-lat`).value;
    const lon = document.querySelector(`#mission-${suffix}-lon`).value;
    if (lat !== "" && lon !== "") setEndpoint(which, lat, lon);
  };
  for (const which of ["start", "end"]) {
    document.querySelector(`#mission-${which}-lat`).addEventListener("change", () => syncCoordinates(which));
    document.querySelector(`#mission-${which}-lon`).addEventListener("change", () => syncCoordinates(which));
  }
  profile.addEventListener("change", () => {
    document.querySelectorAll(".crew-only").forEach((field) => { field.hidden = profile.value !== "crewed"; });
  });

  document.querySelector("#mission-plan-button").addEventListener("click", async () => {
    resultsPanel.hidden = true;
    latestReport = null;
    planButton.disabled = true;
    const estimates = [];
    try {
      const values = readMissionInputs();
      setEndpoint("start", values.start.lat, values.start.lon);
      setEndpoint("end", values.end.lat, values.end.lon);
      for (let index = 0; index < ROUTE_MODES.length; index += 1) {
        const mode = ROUTE_MODES[index];
        status.textContent = `Calculating ${MODE_TITLES[mode]} terrain route (${index + 1} of ${ROUTE_MODES.length})…`;
        try {
          const payload = await requestRoute(mode, values);
          estimates.push({ mode, estimate: makeEstimate(payload, values) });
        } catch (error) {
          estimates.push({ mode, error: error.message });
        }
      }
      const selectedMode = values.mode;
      const selected = estimates.find((item) => item.mode === selectedMode && item.estimate);
      renderOptions(estimates, values, selectedMode, (estimate) => {
        renderRoute(estimate.payload);
        renderSelectedSummary(estimate, values);
        latestReport = buildReport(estimate, values);
      });
      if (!estimates.some((item) => item.estimate)) throw new Error("No route option could be planned. Check endpoints and terrain coverage.");
      resultsPanel.hidden = false;
      if (selected) {
        renderRoute(selected.estimate.payload);
        renderSelectedSummary(selected.estimate, values);
        latestReport = buildReport(selected.estimate, values);
        status.textContent = "Three route priorities compared. Review the selected route and any budget warnings.";
      } else {
        status.textContent = `The selected ${MODE_TITLES[selectedMode]} option was unavailable. Choose another successful route option below.`;
        const first = estimates.find((item) => item.estimate).estimate;
        renderRoute(first.payload);
        renderSelectedSummary(first, values);
        latestReport = buildReport(first, values);
      }
      document.querySelector("#mission-download-report").disabled = false;
    } catch (error) {
      status.textContent = error.message;
      if (!estimates.some((item) => item.estimate)) clearRoute();
    } finally {
      planButton.disabled = false;
    }
  });

  document.querySelector("#mission-clear-button").addEventListener("click", () => {
    clearRoute();
    latestReport = null;
    resultsPanel.hidden = true;
    status.textContent = "Choose a start and destination on the map or enter coordinates.";
    document.querySelector("#mission-audit-result").replaceChildren();
    document.querySelector("#mission-custom-route").value = "";
  });
  document.querySelector("#mission-audit-button").addEventListener("click", auditCustomRoute);
  document.querySelector("#mission-download-report").addEventListener("click", () => {
    if (!latestReport) return;
    const blob = new Blob([JSON.stringify(latestReport, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "marswalk-mission-plan.json";
    link.click();
    URL.revokeObjectURL(url);
  });
  document.querySelector("#mission-print-report").addEventListener("click", () => window.print());
  document.querySelectorAll("#mission-panel .mission-form-grid input, #mission-panel .mission-form-grid select, #mission-priority, #mission-use-vision").forEach((input) => {
    input.addEventListener("change", () => {
      if (latestReport) {
        latestReport = null;
        document.querySelector("#mission-download-report").disabled = true;
        status.textContent = "Mission inputs changed. Recalculate to refresh route options and the report.";
      }
    });
  });
}
