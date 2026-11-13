const http = require("http");
const app = require("./backend/src/app");

const port = Number(process.env.PORT || 5000);
const host = "0.0.0.0";

http.createServer(app).listen(port, host, () => {
  console.log(`MarsWalk is listening on ${host}:${port}`);
});
