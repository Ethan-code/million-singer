// 主程式：管理控制台／舞台兩個視窗，並在控制台、舞台、手機遙控之間轉送狀態與指令。
//
//   控制台（操作者，看得到答案） ──指令──▶ 主程式 ──▶ 舞台（觀眾，遊戲引擎與播放器）
//   手機遙控（區網）              ──指令──▶          ◀──狀態── 舞台
//                                         主程式 ──狀態──▶ 控制台、手機
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const dataDir = require("./data-dir");
const localServer = require("./local-server");
const remoteServer = require("./remote-server");
const lrclib = require("./lrclib");

// 遊戲中要能直接播放（不需使用者先點擊）
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const ROOT = path.join(__dirname, "..");
const webPreferences = {
  nodeIntegration: true,
  contextIsolation: false,
  // 允許頁面讀取本機音檔
  webSecurity: false,
};

let consoleWin = null;
let stageWin = null;
let stageInit = null; // 舞台重新載入（Ctrl+R）時重送
let lastGameState = null;

// ==========================================
// 視窗
// ==========================================

function createConsole() {
  consoleWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    title: "百萬大歌星 控制台",
    webPreferences,
  });
  consoleWin.loadFile(path.join(ROOT, "src", "console", "index.html"));
  consoleWin.on("closed", () => {
    consoleWin = null;
    stageWin?.close();
  });
}

// 有第二個螢幕時，舞台開在控制台以外的螢幕
function pickStageDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length < 2 || !consoleWin) return null;
  const consoleDisplay = screen.getDisplayMatching(consoleWin.getBounds());
  return displays.find((d) => d.id !== consoleDisplay.id) || null;
}

function openStage(init) {
  stageInit = init;
  if (stageWin) {
    stageWin.webContents.send("game:init", init);
    stageWin.show();
    return { display: "existing" };
  }
  const external = pickStageDisplay();
  const b = external?.bounds;
  stageWin = new BrowserWindow({
    ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : { width: 1280, height: 720 }),
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    title: "百萬大歌星",
    webPreferences,
  });
  stageWin.loadFile(path.join(ROOT, "src", "stage", "index.html"));
  let first = true;
  stageWin.webContents.on("did-finish-load", () => {
    if (!stageWin) return;
    if (first && external) stageWin.setFullScreen(true);
    first = false;
    stageWin.webContents.send("game:init", stageInit);
  });
  stageWin.on("closed", () => {
    stageWin = null;
    stageInit = null;
    lastGameState = null;
    consoleWin?.webContents.send("game:ended");
    remoteServer.broadcast({ active: false });
  });
  return { display: external ? "external" : "same" };
}

function sendToStage(cmd) {
  stageWin?.webContents.send("game:command", cmd);
}

// ==========================================
// IPC
// ==========================================

// 選音檔：在 songs/ 外的檔案複製進來，題庫只記檔名，資料夾可整包搬走
async function pickAudio(win) {
  const info = dataDir.resolve();
  if (!info.ok) throw new Error("資料夾無法使用");
  const songsDir = path.join(info.dir, "songs");
  const result = await dialog.showOpenDialog(win, {
    title: "選擇音檔",
    defaultPath: songsDir,
    properties: ["openFile"],
    filters: [
      { name: "音檔", extensions: ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "webm"] },
      { name: "所有檔案", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const src = result.filePaths[0];
  if (path.dirname(path.resolve(src)) === path.resolve(songsDir)) {
    return { filename: path.basename(src), copied: false };
  }
  const ext = path.extname(src);
  const base = path.basename(src, ext);
  let name = path.basename(src);
  for (let i = 2; fs.existsSync(path.join(songsDir, name)); i++) {
    // 同名同大小視為同一個檔案，直接沿用
    if (fs.statSync(path.join(songsDir, name)).size === fs.statSync(src).size) {
      return { filename: name, copied: false };
    }
    name = `${base} (${i})${ext}`;
  }
  fs.copyFileSync(src, path.join(songsDir, name));
  return { filename: name, copied: true };
}

async function pickLyricsFile(win) {
  const result = await dialog.showOpenDialog(win, {
    title: "匯入歌詞檔",
    properties: ["openFile"],
    filters: [{ name: "歌詞", extensions: ["lrc", "txt"] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const text = fs.readFileSync(result.filePaths[0], "utf-8").replace(/^﻿/, "");
  return { name: path.basename(result.filePaths[0]), text };
}

function registerIpc() {
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle("data-dir:get", () => dataDir.resolve());
  ipcMain.handle("data-dir:choose", async (e) => {
    const result = await dialog.showOpenDialog(winOf(e), {
      title: "選擇歌曲與題庫資料夾",
      defaultPath: dataDir.resolve().dir,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return dataDir.setDataDir(result.filePaths[0]);
  });
  ipcMain.handle("data-dir:open", async () => {
    const { dir, ok } = dataDir.resolve();
    if (ok) await shell.openPath(dir);
  });

  ipcMain.handle("audio:pick", (e) => pickAudio(winOf(e)));
  ipcMain.handle("lyrics:pick", (e) => pickLyricsFile(winOf(e)));
  ipcMain.handle("lrclib:search", (e, query) => lrclib.search(query));
  ipcMain.handle("bridge:url", () => localServer.bridgeUrl());
  ipcMain.handle("external:open", (e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  // 遊戲
  ipcMain.handle("game:start", (e, init) =>
    openStage({ ...init, bridgeUrl: localServer.bridgeUrl() })
  );
  ipcMain.on("game:command", (e, cmd) => sendToStage(cmd));
  ipcMain.on("game:state", (e, state) => {
    lastGameState = state;
    consoleWin?.webContents.send("game:state", state);
    remoteServer.broadcast(state);
  });
  ipcMain.handle("game:get-state", () => lastGameState);
  ipcMain.on("game:end", () => stageWin?.close());
  ipcMain.on("stage:fullscreen", (e, on) => {
    if (stageWin) stageWin.setFullScreen(on ?? !stageWin.isFullScreen());
  });
  ipcMain.on("stage:focus", () => stageWin?.focus());

  // 手機遙控
  ipcMain.handle("remote:start", () =>
    remoteServer.start({ onCommand: sendToStage, getState: () => lastGameState })
  );
  ipcMain.handle("remote:stop", () => remoteServer.stop());
  ipcMain.handle("remote:info", () => remoteServer.info());
}

// ==========================================

app.whenReady().then(async () => {
  await localServer.start();
  registerIpc();
  createConsole();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createConsole();
  });
});

app.on("window-all-closed", () => {
  remoteServer.stop();
  if (process.platform !== "darwin") app.quit();
});
