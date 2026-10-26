const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const projectRoot = path.resolve(__dirname, "../../../");
const labelsPath = path.join(projectRoot, "python", "mars_datasets", "data", "processed",
  "vision_prototype", "jezero_ctx", "human_labels", "jezero_visual_review.geojson");
const allowedLabels = new Set(["loose_sand", "rock_field", "crater_rim", "other_hazard", "visually_clear", "uncertain"]);
const bounds = { west: 77.15, east: 77.97, south: 17.70, north: 19.40 };
const emptyCollection = {
  type: "FeatureCollection",
  metadata: {
    region: "Jezero crater local CTX stereo footprint",
    review_method: "visual review without model predictions or weak-label overlays",
    coordinate_order: "longitude_east_deg, latitude_deg",
  },
  features: [],
};

router.get("/labels", (_req, res) => {
  try {
    if (!fs.existsSync(labelsPath)) return res.json(emptyCollection);
    return res.json(JSON.parse(fs.readFileSync(labelsPath, "utf8")));
  } catch (error) {
    console.error("Could not read visual-review labels:", error.message);
    return res.status(500).json({ error: "Saved review labels could not be read." });
  }
});

router.post("/labels", (req, res) => {
  const body = req.body;
  if (!body || body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
    return res.status(400).json({ error: "Send a GeoJSON FeatureCollection." });
  }
  if (body.features.length > 2000) {
    return res.status(413).json({ error: "A review set can contain at most 2,000 polygons." });
  }
  let coordinateCount = 0;
  const features = [];
  for (let index = 0; index < body.features.length; index += 1) {
    const feature = body.features[index];
    const label = feature && feature.properties && feature.properties.label;
    const rings = feature && feature.geometry && feature.geometry.type === "Polygon"
      ? feature.geometry.coordinates : null;
    if (!feature || feature.type !== "Feature" || !allowedLabels.has(label) ||
        !Array.isArray(rings) || !rings.length) {
      return res.status(400).json({ error: "Annotation " + (index + 1) + " has an unsupported label or geometry." });
    }
    if (rings.length > 10) {
      return res.status(400).json({ error: "Annotation " + (index + 1) + " has too many polygon rings." });
    }
    const cleanRings = [];
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4 || ring.length > 10000) {
        return res.status(400).json({ error: "Annotation " + (index + 1) + " contains an invalid polygon ring." });
      }
      const cleanRing = [];
      for (const point of ring) {
        coordinateCount += 1;
        if (coordinateCount > 100000) {
          return res.status(413).json({ error: "The review set contains too many polygon vertices." });
        }
        if (!Array.isArray(point) || point.length < 2) {
          return res.status(400).json({ error: "Annotation " + (index + 1) + " contains an invalid coordinate." });
        }
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) ||
            lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north) {
          return res.status(400).json({ error: "Annotation " + (index + 1) + " is outside the Jezero image footprint." });
        }
        cleanRing.push([lon, lat]);
      }
      const first = cleanRing[0];
      const last = cleanRing[cleanRing.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) cleanRing.push(first.slice());
      cleanRings.push(cleanRing);
    }
    const safeNote = feature.properties && typeof feature.properties.note === "string"
      ? feature.properties.note.slice(0, 240) : "";
    const annotatedAt = feature.properties && typeof feature.properties.annotated_at_utc === "string"
      ? feature.properties.annotated_at_utc.slice(0, 40) : null;
    features.push({
      type: "Feature",
      id: typeof feature.id === "string" ? feature.id.slice(0, 100) : "review-" + (index + 1),
      properties: {
        label,
        note: safeNote,
        review_source: "visual_review_without_model_overlay",
        annotated_at_utc: annotatedAt,
      },
      geometry: { type: "Polygon", coordinates: cleanRings },
    });
  }

  const collection = {
    type: "FeatureCollection",
    metadata: {
      region: "Jezero crater local CTX stereo footprint",
      review_method: "visual review without model predictions or weak-label overlays",
      coordinate_order: "longitude_east_deg, latitude_deg",
      saved_at_utc: new Date().toISOString(),
      feature_count: features.length,
    },
    features,
  };
  try {
    fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
    const temporaryPath = labelsPath + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(collection, null, 2), "utf8");
    fs.renameSync(temporaryPath, labelsPath);
    return res.json({ status: "saved", saved_features: features.length });
  } catch (error) {
    console.error("Could not save visual-review labels:", error.message);
    return res.status(500).json({ error: "Review labels could not be saved on this machine." });
  }
});

module.exports = router;