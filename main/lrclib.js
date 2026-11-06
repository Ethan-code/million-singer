// LRCLIB（https://lrclib.net）歌詞搜尋：免費、社群維護，可能有同步歌詞
const { net } = require("electron");

const USER_AGENT = "MillionSinger (https://github.com/Ethan-code/million-singer)";

async function search({ track, artist }) {
  const params = new URLSearchParams();
  if (track) params.set("track_name", track);
  if (artist) params.set("artist_name", artist);
  if (!track && !artist) return [];
  const res = await net.fetch(`https://lrclib.net/api/search?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`LRCLIB 回應 ${res.status}`);
  const list = await res.json();
  return list.slice(0, 30).map((r) => ({
    id: r.id,
    track: r.trackName,
    artist: r.artistName,
    album: r.albumName,
    duration: r.duration,
    instrumental: r.instrumental,
    synced: r.syncedLyrics || "",
    plain: r.plainLyrics || "",
  }));
}

module.exports = { search };
