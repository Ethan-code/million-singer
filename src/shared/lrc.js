// LRC 歌詞與遮字的純函式工具（renderer 與測試共用，不碰 DOM）

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[[a-z]+:.*\]$/i; // [ar:歌手] 之類的標頭
const MASK = /\*(.*?)\*/g;

// 常見的製作資訊行（作詞、作曲…），匯入時清掉
const CREDIT_LINE =
  /^\s*(作[词詞]|作曲|[编編]曲|[词詞]曲|制作人?|製作人?|[监監]制|[监監]製|演唱|原唱|混音|和[声聲]|合[声聲]|吉他|[贝貝][斯司]|鼓|[弦絃]?[乐樂]手?|[录錄]音|母[带帶]|[企出]品|[发發]行|OP|SP|ISRC|Lyrics?|Composer|Arranger|Producer)\s*[:：]/i;

function formatTime(seconds) {
  const total = Math.max(0, Math.round(seconds * 100));
  const mm = Math.floor(total / 6000);
  const ss = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// "01:02.34" / "1:02.3" / "62.34" → 秒；無法解析回傳 null
function parseTimeText(text) {
  const s = String(text).trim();
  let m = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(s);
  if (m) return toSeconds(m[1], m[2], m[3]);
  m = /^\d+(?:\.\d+)?$/.exec(s);
  return m ? parseFloat(s) : null;
}

function toSeconds(mm, ss, frac) {
  const f = frac ? parseInt(frac.padEnd(3, "0").slice(0, 3), 10) / 1000 : 0;
  return parseInt(mm, 10) * 60 + parseInt(ss, 10) + f;
}

// 解析 LRC。輸入可為字串或字串陣列。
// 回傳 { lines: [{ time, text }], issues: [{ lineNo, raw, reason }] }，lines 依時間排序。
// 一行可有多個時間標籤（[00:12.00][00:45.00]副歌）。
function parseLRC(input) {
  const rawLines = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  const lines = [];
  const issues = [];

  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;
    const trimmed = String(raw).trim();
    if (!trimmed || META_TAG.test(trimmed)) return;

    const tags = [...trimmed.matchAll(TIME_TAG)];
    if (tags.length === 0) {
      issues.push({ lineNo, raw: trimmed, reason: "沒有時間標籤" });
      return;
    }
    const text = trimmed.replace(TIME_TAG, "").trim();
    for (const tag of tags) {
      if (parseInt(tag[2], 10) >= 60) {
        issues.push({ lineNo, raw: trimmed, reason: `秒數 ${tag[2]} 超過 59，建議進位成分鐘` });
      }
      lines.push({ time: toSeconds(tag[1], tag[2], tag[3]), text });
    }
  });

  lines.sort((a, b) => a.time - b.time);
  return { lines, issues };
}

function serializeLRC(lines) {
  return lines.map((l) => `[${formatTime(l.time)}] ${l.text}`);
}

// 判斷貼上的文字是不是 LRC（過半非空行有時間標籤）
function looksLikeLRC(text) {
  const rows = String(text).split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length === 0) return false;
  const tagged = rows.filter((r) => /^\[\d{1,3}:\d{1,2}/.test(r)).length;
  return tagged / rows.length >= 0.5;
}

// 純文字歌詞 → 每行一句、時間未定（null）
function parsePlainLyrics(text) {
  return String(text)
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => ({ time: null, text: r }));
}

function isCreditLine(text) {
  return CREDIT_LINE.test(text);
}

// 清掉製作資訊行與空白歌詞
function cleanLines(lines) {
  return lines.filter((l) => l.text.trim() && !isCreditLine(l.text));
}

// ---------- 遮字 ----------

function getMaskAnswers(text) {
  return [...String(text).matchAll(MASK)].map((m) => m[1]).filter(Boolean);
}

function hasMask(text) {
  return getMaskAnswers(text).length > 0;
}

// 星號不成對（少一個 *）
function hasUnclosedMask(text) {
  return (String(text).match(/\*/g) || []).length % 2 === 1;
}

function stripMasks(text) {
  return String(text).replace(MASK, "$1");
}

// 遮字要顯示幾顆星：英文（半形）單字一顆，其他依字數
function maskStarCounts(answer) {
  return answer
    .split(" ")
    .filter(Boolean)
    .map((part) => (/^[\x00-\xff]*$/.test(part) ? 1 : [...part].length));
}

module.exports = {
  formatTime,
  parseTimeText,
  parseLRC,
  serializeLRC,
  looksLikeLRC,
  parsePlainLyrics,
  isCreditLine,
  cleanLines,
  getMaskAnswers,
  hasMask,
  hasUnclosedMask,
  stripMasks,
  maskStarCounts,
};
