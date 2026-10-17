const http = require("http");
const express = require("express");
const app = require("./backend/src/app");

app.listen("8000", () => {
  console.log("Server is running at 8000");
});
