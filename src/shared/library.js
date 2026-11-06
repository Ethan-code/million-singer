// 題庫檔案讀寫（Node fs，renderer 與測試共用）
const fs = require("fs");
const path = require("path");
const { normalizeSong, serializeSong } = require("./song");

const playlistsDir = (dataDir) => path.join(dataDir, "playlists");
const songsDir = (dataDir) => path.join(dataDir, "songs");

function listPlaylists(dataDir) {
  return fs
    .readdirSync(playlistsDir(dataDir), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".json"))
    .map((d) => ({ file: d.name, name: d.name.replace(/\.json$/i, "") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// 回傳 { raw（原始 JSON）, songs（正規化後）, error }
function readPlaylist(dataDir, file) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(playlistsDir(dataDir), file), "utf-8"));
    const songs = Array.isArray(raw) ? raw.map(normalizeSong) : [];
    return { raw, songs, error: Array.isArray(raw) ? null : "最外層必須是歌曲陣列" };
  } catch (e) {
    return { raw: null, songs: [], error: e.message };
  }
}

// 先寫暫存檔再改名，避免寫到一半當掉留下壞檔；舊檔備份到 playlists/.backup/
function writePlaylist(dataDir, file, songs) {
  const dir = playlistsDir(dataDir);
  const target = path.join(dir, file);
  if (fs.existsSync(target)) {
    const backupDir = path.join(dir, ".backup");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(target, path.join(backupDir, `${file}.bak`));
  }
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(songs.map(serializeSong), null, 2) + "\n");
  fs.renameSync(tmp, target);
}

// 檔名不能用的字元換掉；同名就加編號。回傳新檔名。
function createPlaylist(dataDir, name) {
  const safe = String(name).trim().replace(/[\\/:*?"<>|]/g, "_") || "新題庫";
  let file = `${safe}.json`;
  for (let i = 2; fs.existsSync(path.join(playlistsDir(dataDir), file)); i++) {
    file = `${safe} (${i}).json`;
  }
  fs.writeFileSync(path.join(playlistsDir(dataDir), file), "[]\n");
  return file;
}

function songFileExists(dataDir, filename) {
  return !!filename && fs.existsSync(path.join(songsDir(dataDir), filename));
}

module.exports = {
  playlistsDir,
  songsDir,
  listPlaylists,
  readPlaylist,
  writePlaylist,
  createPlaylist,
  songFileExists,
};
