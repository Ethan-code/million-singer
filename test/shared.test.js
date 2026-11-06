const test = require("node:test");
const assert = require("node:assert/strict");
const lrc = require("../src/shared/lrc");
const song = require("../src/shared/song");
const { checkPlaylist, summarize } = require("../src/shared/checker");

test("formatTime / parseTimeText", () => {
  assert.equal(lrc.formatTime(60.41), "01:00.41");
  assert.equal(lrc.formatTime(0), "00:00.00");
  assert.equal(lrc.parseTimeText("01:00.41"), 60.41);
  assert.equal(lrc.parseTimeText("1:2.5"), 62.5);
  assert.equal(lrc.parseTimeText("62.3"), 62.3);
  assert.equal(lrc.parseTimeText("abc"), null);
});

test("parseLRC: sorting, multi tags, metadata, issues", () => {
  const { lines, issues } = lrc.parseLRC([
    "[ar:someone]",
    "[00:45.00][00:12.5]副歌",
    "[00:20.92] 第二句",
    "沒有時間",
    "[00:60.41] *答案*",
  ]);
  assert.deepEqual(lines.map((l) => l.time), [12.5, 20.92, 45, 60.41]);
  assert.equal(lines[0].text, "副歌");
  assert.equal(issues.length, 2);
  assert.match(issues[0].reason, /沒有時間標籤/);
  assert.match(issues[1].reason, /超過 59/);
});

test("serialize round trip", () => {
  const src = ["[00:11.00] （前奏）", "[01:00.41] *一心一德*貫徹始終"];
  assert.deepEqual(lrc.serializeLRC(lrc.parseLRC(src).lines), src);
});

test("looksLikeLRC / plain / credits", () => {
  assert.equal(lrc.looksLikeLRC("[00:01.00] a\n[00:02.00] b"), true);
  assert.equal(lrc.looksLikeLRC("a\nb"), false);
  assert.equal(lrc.parsePlainLyrics("a\n\n b ").length, 2);
  assert.equal(lrc.isCreditLine("作词 : 某人"), true);
  assert.equal(lrc.isCreditLine("編曲：某人"), true);
  assert.equal(lrc.isCreditLine("我愛你"), false);
});

test("masks", () => {
  assert.deepEqual(lrc.getMaskAnswers("*一心*一德*貫徹*"), ["一心", "貫徹"]);
  assert.equal(lrc.hasUnclosedMask("*abc"), true);
  assert.equal(lrc.stripMasks("*一心*一德"), "一心一德");
  assert.deepEqual(lrc.maskStarCounts("I love 你們"), [1, 1, 2]);
});

test("parseYouTubeId", () => {
  const id = "aqz-KE-bpKQ";
  for (const u of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=10`,
    `https://youtu.be/${id}?si=x`,
    `https://www.youtube.com/embed/${id}`,
    `https://m.youtube.com/shorts/${id}`,
    `https://music.youtube.com/watch?v=${id}`,
  ]) {
    assert.equal(song.parseYouTubeId(u), id, u);
  }
  assert.equal(song.parseYouTubeId("https://example.com/watch?v=" + id), null);
});

test("resolveSource preference", () => {
  const s = song.normalizeSong({ filename: "a.mp3", youtube: "aqz-KE-bpKQ", youtubeOffset: 1.5 });
  const exists = () => true;
  assert.equal(song.resolveSource(s, { fileExists: exists }).type, "file");
  assert.equal(song.resolveSource(s, { fileExists: exists, prefer: "youtube" }).type, "youtube");
  assert.equal(song.resolveSource(s, { fileExists: () => false }).offset, 1.5);
  assert.equal(song.resolveSource(song.normalizeSong({}), {}), null);
});

test("serializeSong omits empty fields", () => {
  const out = song.serializeSong(song.normalizeSong({ title: "t", filename: "a.mp3", lrc: ["x"] }));
  assert.deepEqual(Object.keys(out), ["title", "filename", "lrc"]);
});

test("checkPlaylist", () => {
  const exists = (f) => f === "ok.mp3";
  assert.equal(checkPlaylist({}, {})[0].level, "error");
  assert.equal(checkPlaylist([], {})[0].message, "題庫是空的");

  const good = [{ title: "a", filename: "ok.mp3", startTime: 0, endTime: 80, lrc: ["[00:10.00] *答*"] }];
  assert.deepEqual(checkPlaylist(good, { fileExists: exists }), []);

  const bad = [
    { title: "b", filename: "missing.mp3", lrc: ["[00:10.00] x"] },
    { title: "c", filename: "ok.mp3", startTime: 50, endTime: 40, lrc: ["[00:10.00] *x"] },
    { title: "d", filename: "missing.mp3", youtube: "aqz-KE-bpKQ", endTime: 30, lrc: ["[00:40.00] *y*"] },
  ];
  const issues = checkPlaylist(bad, { fileExists: exists });
  const msgs = issues.map((i) => `${i.round}:${i.level}:${i.message}`);
  assert.ok(msgs.some((m) => m.startsWith("1:error:找不到音檔")), msgs.join("\n"));
  assert.ok(msgs.some((m) => m.startsWith("1:warning:沒有遮字句")));
  assert.ok(msgs.some((m) => m.startsWith("2:error:開始時間")));
  assert.ok(msgs.some((m) => m.includes("沒有成對")));
  assert.ok(msgs.some((m) => m.startsWith("3:warning:找不到音檔") && m.includes("YouTube")));
  assert.ok(msgs.some((m) => m.startsWith("3:warning:使用 YouTube")));
  assert.ok(msgs.some((m) => m.startsWith("3:warning:") && m.includes("播放範圍外")));
  assert.deepEqual(summarize(issues).errors, 2);
});

test("writePlaylist keeps timestamped backups", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const library = require("../src/shared/library");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
  fs.mkdirSync(path.join(dir, "playlists"));
  const file = library.createPlaylist(dir, "測試");
  const song = { title: "a", lrc: ["[00:01.00] x"] };
  library.writePlaylist(dir, file, [song]);
  const backups = fs.readdirSync(path.join(dir, "playlists", ".backup"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^測試\.\d{8}-\d{6}\.json$/);
  assert.equal(library.readPlaylist(dir, file).songs[0].title, "a");
  fs.rmSync(dir, { recursive: true });
});
