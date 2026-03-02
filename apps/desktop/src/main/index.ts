import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let apiProcess: ChildProcess | null = null;
const DB_PATH = "C:\\\\ProgramData\\\\Sella\\\\data\\\\sella.db";
const logPath = path.join(app.getPath("userData"), "main.log");
const apiLogPath = path.join(app.getPath("userData"), "api.log");
const log = (msg: string) => {
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
};
const logApi = (msg: string) => {
  try {
    fs.appendFileSync(apiLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
};

const gotLock = app.requestSingleInstanceLock();

const startApi = () => {
  // Start local API as background node process (avoid spawning another Electron instance)
  const apiEntry = path.join(app.getAppPath(), "api-server.cjs");
  const child = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      DB_PATH,
      PORT: "3333",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  });
  child.on?.("error", (err: any) => {
    log(`API spawn error: ${err?.message ?? String(err)}`);
    logApi(`Spawn error: ${err?.stack ?? err?.message ?? String(err)}`);
  });
  child.unref?.();
  log(`API spawned pid=${child?.pid ?? "n/a"} DB=${DB_PATH} entry=${apiEntry}`);
  logApi(`Spawned pid=${child?.pid ?? "n/a"} entry=${apiEntry} DB=${DB_PATH}`);
  child.stdout?.on("data", (buf) => logApi(String(buf)));
  child.stderr?.on("data", (buf) => logApi(String(buf)));
  child.on("exit", (code, signal) => {
    log(`API exit code=${code} signal=${signal ?? "none"}`);
    logApi(`Exit code=${code} signal=${signal ?? "none"}`);
  });
  apiProcess = child;
};

const stopApi = async () => {
  if (!apiProcess?.pid) return;
  try {
    process.kill(-apiProcess.pid);
  } catch {}
  // Give Windows a moment to release file handles
  await new Promise((r) => setTimeout(r, 400));
  apiProcess = null;
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true, // Show immediately for faster perceived load
    center: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      // Performance optimizations
      backgroundThrottling: false,
      contextIsolation: true,
    },
    title: "SELLA – Offline POS System",
  });

  const indexHtml = path.join(__dirname, "../renderer/index.html");

  // Optimize: don't wait for ready-to-show since we show immediately
  win.webContents.on("render-process-gone", (_e, details) => {
    log(`Renderer gone: ${details.reason} code=${details.exitCode}`);
  });

  win.webContents.on("unresponsive", () => {
    log("Renderer unresponsive");
  });

  // Surface load failures
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    log(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL).catch((err) => {
      log(`Failed to load dev URL: ${err?.message}`);
    });
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // Production: load file without opening devtools
    win.loadFile(indexHtml).catch((err) => {
      log(`Failed to load index.html at ${indexHtml}: ${err?.message}`);
    });
  }
};

if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    // Ensure DB directory exists
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    startApi();

    // Create window immediately - API will be ready by the time React loads
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (apiProcess) {
      try {
        process.kill(-apiProcess.pid!);
      } catch {}
    }
    app.quit();
  }
});

ipcMain.handle("ping", () => "pong");

ipcMain.handle("backup-db", async (_event, args: { destDir?: string }) => {
  const destDir = (args?.destDir || "").trim();
  if (!destDir) throw new Error("Backup folder path is not set.");
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database not found at ${DB_PATH}`);
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const destFile = path.join(destDir, `sella-backup_${stamp}.db`);
  fs.copyFileSync(DB_PATH, destFile);
  const size = fs.statSync(destFile).size;
  log(`Backup created ${destFile} bytes=${size}`);
  return { destFile, size, when: new Date().toISOString() };
});

ipcMain.handle("choose-restore-db", async () => {
  const res = await dialog.showOpenDialog({
    title: "Select SELLA database backup",
    properties: ["openFile"],
    filters: [
      { name: "SQLite DB", extensions: ["db", "sqlite", "sqlite3"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths?.[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle("restore-db", async (_event, args: { filePath?: string }) => {
  const filePath = (args?.filePath || "").trim();
  if (!filePath) throw new Error("No file selected.");
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  await stopApi();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.copyFileSync(filePath, DB_PATH);
  log(`DB restored from ${filePath} -> ${DB_PATH}`);
  startApi();
  return { ok: true };
});

ipcMain.handle("reset-db", async () => {
  await stopApi();
  try {
    if (fs.existsSync(DB_PATH)) {
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .replace("Z", "");
      const archive = path.join(path.dirname(DB_PATH), `sella-archive_${stamp}.db`);
      fs.copyFileSync(DB_PATH, archive);
      fs.unlinkSync(DB_PATH);
      log(`DB reset: archived ${archive} and deleted active DB ${DB_PATH}`);
    }
  } catch (e: any) {
    log(`DB reset error: ${e?.message ?? String(e)}`);
  }
  startApi();
  return { ok: true };
});

ipcMain.handle("app-version", () => app.getVersion());

ipcMain.handle("print-to-pdf", async (_event, args: { html?: string }) => {
  const html = String(args?.html || "");
  if (!html.trim()) throw new Error("Missing HTML");
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1100,
    backgroundColor: "#ffffff",
    webPreferences: {
      sandbox: false,
    },
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(url);
  await new Promise((r) => setTimeout(r, 200));
  const buf = await win.webContents.printToPDF({
    pageSize: "A4",
    printBackground: true,
  });
  win.destroy();
  return buf.toString("base64");
});

