#!/usr/bin/env node
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

// Resolve API entry depending on packaged or dev path
const packagedEntry = path.join(process.resourcesPath || "", "api", "index.js");
const devEntry = path.join(__dirname, "../..", "packages", "api", "dist", "index.js");
const serverEntry = fs.existsSync(packagedEntry) ? packagedEntry : devEntry;

// Ensure API deps resolve from the packaged app's node_modules
if (process.resourcesPath) {
  const candidateNodeModules = [
    path.join(process.resourcesPath, "app.asar", "node_modules"),
    path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
  ].filter((p) => fs.existsSync(p));

  if (candidateNodeModules.length) {
    process.env.NODE_PATH = [process.env.NODE_PATH, ...candidateNodeModules]
      .filter(Boolean)
      .join(path.delimiter);
    Module._initPaths();
  }
}

process.env.DB_PATH = process.env.DB_PATH || "C:\\\\ProgramData\\\\Sella\\\\data\\\\sella.db";
process.env.PORT = process.env.PORT || "3333";
process.env.ELECTRON_RUN_AS_NODE = "1";

// The API entry starts listening on import/require.
require(serverEntry);

