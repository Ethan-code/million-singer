// 歌曲與題庫資料夾：放在 app 外面，使用者可自行加檔與變更位置
//
//   <資料夾>/
//     songs/       音檔
//     playlists/   題庫 .json
//
// 預設是「文件/MillionSinger」，第一次建立時複製內附範例進去。
// 使用者選過的位置記在 userData/config.json。
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const DEFAULT_DIR_NAME = "MillionSinger";
const SUBDIRS = ["songs", "playlists"];

const configPath = () => path.join(app.getPath("userData"), "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function samplesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "samples")
    : path.join(__dirname, "..", "samples");
}

function ensureSubdirs(dir) {
  for (const sub of SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
}

// 回傳 { dir, ok, error? }
function resolve() {
  const { dataDir } = readConfig();

  // 使用者指定過的資料夾：不存在就回報（可能是外接硬碟沒插），不自動建立
  if (dataDir) {
    if (!fs.existsSync(dataDir)) return { dir: dataDir, ok: false, error: "not-found" };
    try {
      ensureSubdirs(dataDir);
      return { dir: dataDir, ok: true };
    } catch (e) {
      return { dir: dataDir, ok: false, error: e.message };
    }
  }

  // 預設資料夾：不存在就建立並放入範例
  const dir = path.join(app.getPath("documents"), DEFAULT_DIR_NAME);
  try {
    const isNew = !fs.existsSync(dir);
    ensureSubdirs(dir);
    if (isNew && fs.existsSync(samplesDir())) {
      fs.cpSync(samplesDir(), dir, { recursive: true, force: false });
    }
    return { dir, ok: true };
  } catch (e) {
    return { dir, ok: false, error: e.message };
  }
}

function setDataDir(dir) {
  writeConfig({ ...readConfig(), dataDir: dir });
  return resolve();
}

module.exports = { resolve, setDataDir, readConfig, writeConfig };
