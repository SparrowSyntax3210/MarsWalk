const http = require("http");
const app = require("./backend/src/app");

const host = process.env.HOST || "127.0.0.1";
const requestedPort = Number(process.env.PORT || 5000);
const maximumFallbacks = 20;

function listenOnAvailablePort(port, fallbackCount = 0) {
  const server = http.createServer(app);
  server.once("error", (error) => {
    if ((error.code === "EADDRINUSE" || error.code === "EACCES") && fallbackCount < maximumFallbacks) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is unavailable (${error.code}); trying ${nextPort}.`);
      listenOnAvailablePort(nextPort, fallbackCount + 1);
      return;
    }
    console.error(`MarsWalk could not start on ${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`MarsWalk is running at http://${host}:${port}`);
  });
}

listenOnAvailablePort(requestedPort);
