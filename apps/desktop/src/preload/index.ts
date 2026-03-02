import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  ping: () => ipcRenderer.invoke("ping"),
  backupDb: (destDir: string) => ipcRenderer.invoke("backup-db", { destDir }),
  chooseRestoreDb: () => ipcRenderer.invoke("choose-restore-db"),
  restoreDb: (filePath: string) => ipcRenderer.invoke("restore-db", { filePath }),
  resetDb: () => ipcRenderer.invoke("reset-db"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  printToPdf: (html: string) => ipcRenderer.invoke("print-to-pdf", { html }),
});

