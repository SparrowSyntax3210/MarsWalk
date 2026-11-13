const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const express = require("express");

const router = express.Router();
const workspaceRoot = path.resolve(__dirname, "../../../python/mars_datasets");
const projectPythonExe = path.join(workspaceRoot, "scripts", ".venv", "Scripts", "python.exe");
const pythonExe = process.env.MARS_PYTHON ||
  (fs.existsSync(projectPythonExe) ? projectPythonExe : (process.platform === "win32" ? "py" : "python3"));
const plannerScript = path.join(workspaceRoot, "scripts", "global_tile_route_planner.py");
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
router.get("/status", (_req, res) => {
  const catalogPath = path.join(workspaceRoot, "data", "processed", "route_regions", "catalog.csv");
  try {
    const tiles = fs.readFileSync(catalogPath, "utf8").trim().split(/\r?\n/).slice(1)
      .filter(Boolean).map((line) => {
        const [tileId, region, west, south, east, north, status, parquetPath, manifestPath] = line.split(",");
        const parquet = path.resolve(workspaceRoot, parquetPath.replace(/[\\/]/g, path.sep));
        const manifest = path.resolve(workspaceRoot, manifestPath.replace(/[\\/]/g, path.sep));
        return { tileId, region, west: Number(west), south: Number(south), east: Number(east), north: Number(north), status, available: fs.existsSync(parquet) && fs.existsSync(manifest) };
      });
    const available = tiles.filter((tile) => tile.status === "complete" && tile.available);
    return res.json({
      planner: "global_tile_route_planner.py",
      data: "curated regional terrain grids derived from the local global Mars dataset (nominal approximately 1 km cells)",
      status: available.length === tiles.length ? "complete" : available.length ? "partial" : "unavailable",
      complete_tiles: available.length,
      total_tiles: tiles.length,
      regions: available.map(({ tileId, region, west, south, east, north }) => ({ id: tileId, name: region, bounds: { west, south, east, north } })),
      maximum_route_km: 100,
    });
  } catch (error) {
    return res.status(503).json({ planner: "global_tile_route_planner.py", status: "unavailable", error: "Hosted regional route catalog is missing or unreadable." });
  }
});
router.post("/", (req, res) => {
  if (path.isAbsolute(pythonExe) && !fs.existsSync(pythonExe)) {
    return res.status(503).json({ error: "The configured Mars Python interpreter was not found.", python: pythonExe });
  }
  if (!fs.existsSync(plannerScript)) {
    return res.status(503).json({ error: "The adaptive route planner script was not found.", script: plannerScript });
  }
  const payload = req.body;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ error: "Send a JSON object with start and end coordinates." });
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_INPUT_BYTES) {
    return res.status(413).json({ error: "Route request is too large." });
  }

  const child = spawn(pythonExe, [plannerScript], { cwd: workspaceRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    child.kill();
    finish(504, { error: "Route calculation exceeded the 5 minute limit." });
  }, TIMEOUT_MS);
  const finish = (status, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    res.status(status).json(result);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
      child.kill();
      finish(502, { error: "Route response exceeded its size limit." });
    }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.on("error", (error) => finish(503, { error: `Could not start the local Python route planner: ${error.message}` }));
  res.on("close", () => {
    if (!res.writableEnded && !settled) {
      settled = true;
      clearTimeout(timer);
      child.kill();
    }
  });
  child.on("close", (code) => {
    if (settled) return;
    let result;
    try {
      if (!stdout.trim()) {
        return finish(502, {
          error: "The Python route planner produced no JSON output.",
          details: stderr.trim().slice(-2000) || `Python exited with code ${code} and no diagnostic output.`,
        });
      }
      result = JSON.parse(stdout);
    } catch {
      console.error("Route planner returned invalid JSON", stderr);
      return finish(502, {
        error: "The Python route planner returned invalid JSON.",
        details: stderr.trim().slice(-2000) || stdout.trim().slice(0, 1000),
      });
    }
    if (code !== 0 || result.error) {
      return finish(result.error ? 422 : 502, result);
    }
    return finish(200, result);
  });
  child.stdin.end(body);
});

module.exports = router;
