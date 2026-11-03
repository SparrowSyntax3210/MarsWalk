const { spawn } = require("child_process");
const express = require("express");
const path = require("path");
const fs = require("fs");

// Nearest-cell lookup in the local global feature store (10-degree Parquet
// tiles, nominal ~1 km). Returns precomputed attributes only.
const router = express.Router();
const workspaceRoot = path.resolve(__dirname, "../../../python/mars_datasets");
const projectPythonExe = path.join(workspaceRoot, "scripts", ".venv", "Scripts", "python.exe");
const pythonExe = fs.existsSync(projectPythonExe) ? projectPythonExe : (process.env.MARS_PYTHON || projectPythonExe);
const lookupScript = path.join(workspaceRoot, "scripts", "point_cell_lookup.py");
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const CACHE_LIMIT = 200;
const cache = new Map();

function runLookup(lat, lon) {
  return new Promise((resolve, reject) => {
    // Arguments are passed as an array (no shell), so values cannot inject commands.
    const child = spawn(pythonExe, [lookupScript, String(lat), String(lon)], {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Object.assign(new Error("Feature-store lookup timed out."), { status: 504 }));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`Could not start the feature-store lookup: ${error.message}`), { status: 503 }));
    });
    child.on("close", () => {
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(Object.assign(new Error(stderr.trim().split(/\r?\n/).pop() || "Feature-store lookup returned invalid output."), { status: 502 }));
      }
      if (result.error) return reject(Object.assign(new Error(result.error), { status: 404 }));
      resolve(result);
    });
  });
}

/**
 * Nearest feature-store cell for a coordinate, cached. Shared with Ruby so it
 * can look up any place the user names. Rejects with an error carrying `status`.
 */
function lookupCell(lat, lon) {
  if (!fs.existsSync(pythonExe) || !fs.existsSync(lookupScript)) {
    return Promise.reject(Object.assign(new Error("The local feature-store lookup is not installed."), { status: 503 }));
  }
  // ~1 km cells: 0.005° keys reuse a lookup for repeat clicks in the same cell.
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!cache.has(key)) {
    const pending = runLookup(lat, lon);
    cache.set(key, pending);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    pending.catch(() => cache.delete(key));
  }
  return cache.get(key);
}

router.get("/", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: "Provide latitude from -90 to 90 and longitude from -180 to 180." });
  }
  try {
    res.json(await lookupCell(lat, lon));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.lookupCell = lookupCell;
