const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const express = require("express");

const router = express.Router();
const workspaceRoot = path.resolve(__dirname, "../../../python/mars_datasets");
const projectPythonExe = path.join(workspaceRoot, "scripts", ".venv", "Scripts", "python.exe");
// Prefer the project's installed GIS environment; an inherited MARS_PYTHON may point
// at an unrelated runtime without pandas/pyarrow.
const pythonExe = fs.existsSync(projectPythonExe) ? projectPythonExe : (process.env.MARS_PYTHON || projectPythonExe);
const plannerScript = path.join(workspaceRoot, "scripts", "global_tile_route_planner.py");
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 90_000;

router.get("/status", (_req, res) => {
  const catalogPath = path.join(workspaceRoot, "data", "processed", "feature_store", "global_tiles", "tiles_catalog.csv");
  let statuses = [];
  try {
    statuses = fs.readFileSync(catalogPath, "utf8").trim().split(/\r?\n/).slice(1)
      .filter(Boolean).map((line) => line.split(",")[5]);
  } catch (error) {
    return res.status(503).json({ planner: "global_tile_route_planner.py", status: "unavailable", error: "Global tile catalog is missing or unreadable." });
  }
  const complete = statuses.filter((status) => status === "complete").length;
  res.json({
    planner: "global_tile_route_planner.py",
    data: "global 10-degree Parquet tiles",
    status: complete === 648 ? "complete" : complete > 0 ? "partial" : "unavailable",
    complete_tiles: complete,
    total_tiles: statuses.length,
    remaining_tiles: Math.max(0, statuses.length - complete),
  });
});

router.post("/", (req, res) => {
  if (!fs.existsSync(pythonExe)) {
    return res.status(503).json({ error: "The configured Mars Python interpreter was not found.", python: pythonExe });
  }
  if (!fs.existsSync(plannerScript)) {
    return res.status(503).json({ error: "The global-tile route planner script was not found.", script: plannerScript });
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
    finish(504, { error: "Route calculation exceeded the 90 second limit." });
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
