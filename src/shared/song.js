// 歌曲資料：正規化、音源判斷（純函式）
//
// 題庫 JSON 是歌曲陣列，每首歌欄位：
//   title, artist, filename（songs/ 內的檔名）, url, youtube（影片 ID）,
//   youtubeOffset（YouTube 版本相對於歌詞時間軸的偏移秒數）,
//   startTime, endTime, lrc（字串陣列）

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

// 從各種 YouTube 網址取出影片 ID；不是 YouTube 回傳 null
function parseYouTubeId(input) {
  const s = String(input || "").trim();
  if (YT_ID.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
      if (m) id = m[1];
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSong(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const lrc = Array.isArray(s.lrc)
    ? s.lrc.map(String)
    : typeof s.lrc === "string"
      ? s.lrc.split(/\r?\n/)
      : [];
  return {
    title: String(s.title || ""),
    artist: String(s.artist || ""),
    filename: String(s.filename || ""),
    url: String(s.url || ""),
    youtube: parseYouTubeId(s.youtube) || "",
    youtubeOffset: num(s.youtubeOffset),
    startTime: Math.max(0, num(s.startTime)),
    endTime: Math.max(0, num(s.endTime)),
    lrc,
  };
}

// 存檔用：省略空欄位，保持 JSON 精簡、與舊版相容
function serializeSong(song) {
  const out = { title: song.title };
  if (song.artist) out.artist = song.artist;
  if (song.filename) out.filename = song.filename;
  if (song.url) out.url = song.url;
  if (song.youtube) out.youtube = song.youtube;
  if (song.youtube && song.youtubeOffset) out.youtubeOffset = song.youtubeOffset;
  if (song.startTime) out.startTime = song.startTime;
  if (song.endTime) out.endTime = song.endTime;
  out.lrc = song.lrc;
  return out;
}

// 依偏好決定這首歌實際用哪個音源。
// fileExists(filename) 由呼叫端提供（renderer 用 fs）。
// prefer: "local"（預設，本地檔優先）或 "youtube"
// 回傳 { type: "file" | "url" | "youtube", ... } 或 null
function resolveSource(song, { fileExists, prefer = "local" } = {}) {
  const local =
    song.filename && fileExists && fileExists(song.filename)
      ? { type: "file", filename: song.filename }
      : null;
  const remote = song.url ? { type: "url", url: song.url } : null;
  const yt = song.youtube
    ? { type: "youtube", videoId: song.youtube, offset: song.youtubeOffset || 0 }
    : null;
  const order = prefer === "youtube" ? [yt, local, remote] : [local, remote, yt];
  return order.find(Boolean) || null;
}

function needsNetwork(source) {
  return !!source && source.type !== "file";
}

module.exports = {
  parseYouTubeId,
  normalizeSong,
  serializeSong,
  resolveSource,
  needsNetwork,
};
