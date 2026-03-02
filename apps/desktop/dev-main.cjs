const path = require("path");

// Register ts-node for on-the-fly TypeScript transpilation in the main process.
require("ts-node").register({
  transpileOnly: true,
  project: path.join(__dirname, "tsconfig.main.json"),
  compilerOptions: {
    module: "CommonJS",
  },
});

// Start the actual Electron main process entry.
require("./src/main/index.ts");








