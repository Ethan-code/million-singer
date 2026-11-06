// 題庫檢查：上台前找出會出事的地方（純函式）
const { formatTime } = require("./lrc");
const { normalizeSong, resolveSource, needsNetwork } = require("./song");

// 回傳 [{ round（從 1 起算，0 代表整個題庫）, level: "error"|"warning", message }]
function checkPlaylist(data, { fileExists, prefer } = {}) {
  if (!Array.isArray(data)) {
    return [{ round: 0, level: "error", message: "題庫格式錯誤：最外層必須是歌曲陣列" }];
  }
  if (data.length === 0) {
    return [{ round: 0, level: "error", message: "題庫是空的" }];
  }
  return data.flatMap((raw, i) => checkSong(normalizeSong(raw), i + 1, { fileExists, prefer }));
}

function checkSong(song, round, { fileExists, prefer } = {}) {
  const issues = [];
  const add = (level, message) => issues.push({ round, level, message });

  if (!song.title) add("warning", "沒有歌名");

  const source = resolveSource(song, { fileExists, prefer });
  if (!source) {
    if (song.filename) add("error", `找不到音檔「${song.filename}」`);
    else add("error", "沒有設定音源（本地檔案或 YouTube）");
  } else {
    if (song.filename && source.type !== "file" && fileExists && !fileExists(song.filename)) {
      add("warning", `找不到音檔「${song.filename}」，改用${source.type === "youtube" ? " YouTube" : "網址"}`);
    }
    if (needsNetwork(source)) {
      add("warning", source.type === "youtube" ? "使用 YouTube，需要網路" : "使用網址音源，需要網路");
    }
  }

  if (song.endTime > 0 && song.startTime >= song.endTime) {
    add("error", `開始時間（${song.startTime}s）不早於結束時間（${song.endTime}s）`);
  }

  const untimed = song.lines.filter((l) => l.time === null && l.text.trim()).length;
  if (untimed) add("warning", `還有 ${untimed} 行沒有時間（遊戲中不會顯示）`);
  const lines = song.lines.filter((l) => l.time !== null && l.text.trim());
  if (lines.length === 0) {
    add("error", "沒有可用的歌詞");
    return issues;
  }

  const masked = lines.filter((l) => l.masked);
  if (masked.length === 0) add("warning", "沒有遮字句（不會停下來）");

  const end = song.endTime > 0 ? song.endTime : Infinity;
  for (const l of masked) {
    if (l.time < song.startTime || l.time >= end) {
      add("warning", `[${formatTime(l.time)}] 遮字句在播放範圍外，不會出現`);
    }
  }
  return issues;
}

function summarize(issues) {
  return {
    errors: issues.filter((i) => i.level === "error").length,
    warnings: issues.filter((i) => i.level === "warning").length,
  };
}

module.exports = { checkPlaylist, checkSong, summarize };
