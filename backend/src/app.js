const express = require("express");
const cors = require("cors");
const path = require("path");
const elevationRoutes = require("./routes/elevation");
const pointRoutes = require("./routes/point");

const app = express();
const publicDirectory = path.resolve(__dirname, "../../frontend/public");

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/elevation", elevationRoutes);
app.use("/api/point", pointRoutes);
app.use(express.static(publicDirectory));

app.use((error, _req, res, _next) => {
  console.error("Unhandled request error:", error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

module.exports = app;
