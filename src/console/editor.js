// 歌曲編輯器：設定音源、匯入歌詞、打拍子同步、波形微調遮字停點、試停。
//
// 只有「遮字句」的時間需要精準（停點 = 歌詞時間 - STOP_LEAD），其他句子粗對即可。
const fs = require("fs");
const path = require("path");
const { ipcRenderer } = require("electron");
const lrc = require("../shared/lrc");
const { parseYouTubeId, serializeSong, STOP_LEAD } = require("../shared/song");
const { checkSong } = require("../shared/checker");
const library = require("../shared/library");
const { createPlayer } = require("../player/players");
const { toast } = require("../ui/toast");
const modal = require("../ui/modal");

const WAVE_SPAN = 8; // 波形視窗寬度（秒）
const PEAKS_PER_SEC = 100;
const NUDGE = 0.05;

let current = null; // 目前開著的編輯器（同時只會有一個）

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else if (k === "value") node.value = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// LRC 字串陣列 → 編輯用的行（保留原順序；沒有時間標籤的行時間為 null）
function linesFromLrc(lrcLines) {
  const out = [];
  for (const raw of lrcLines) {
    const trimmed = String(raw).trim();
    if (!trimmed || /^\[[a-z]+:.*\]$/i.test(trimmed)) continue;
    const parsed = lrc.parseLRC([trimmed]).lines;
    if (parsed.length) out.push(...parsed.map((l) => ({ time: l.time, text: l.text })));
    else out.push({ time: null, text: trimmed });
  }
  if (out.every((l) => l.time !== null)) out.sort((a, b) => a.time - b.time);
  return out;
}

function linesToLrc(lines) {
  return lines.map((l) => (l.time === null ? l.text : `[${lrc.formatTime(l.time)}] ${l.text}`));
}

function round2(t) {
  return Math.round(t * 100) / 100;
}

// ==========================================

function openEditor({ container, dataDir, playlistFile, songs, index, onClose }) {
  current?.destroy();
  const isNew = index === null || index === undefined;
  const base = isNew ? { title: "", artist: "", filename: "", url: "", youtube: "", youtubeOffset: 0, startTime: 0, endTime: 0, lrc: [] } : songs[index];

  const draft = {
    title: base.title,
    artist: base.artist,
    filename: base.filename,
    url: base.url,
    youtube: base.youtube,
    youtubeOffset: base.youtubeOffset,
    startTime: base.startTime,
    endTime: base.endTime,
    lines: linesFromLrc(base.lrc),
  };

  const ed = {
    draft,
    dirty: isNew,
    selected: draft.lines.length ? 0 : -1,
    tapMode: false,
    previewType: null,
    player: null,
    peaks: null,
    peaksFor: null,
    testStopAt: null,
    testTimer: null,
    raf: 0,
    waveCenter: null,
  };

  const fileExists = (f) => library.songFileExists(dataDir, f);
  const markDirty = () => {
    ed.dirty = true;
    refs.save.classList.add("btn--primary");
    scheduleCheck();
  };

  // ---------- 版面 ----------

  const refs = {};
  const field = (label, input, ...extra) =>
    el("label", { class: "ed-field" }, el("span", { class: "ed-field__label", text: label }), input, ...extra);

  refs.title = el("input", { class: "input", value: draft.title, placeholder: "歌名（揭曉時顯示）" });
  refs.artist = el("input", { class: "input", value: draft.artist, placeholder: "歌手（搜尋歌詞用）" });
  refs.fileName = el("span", { class: "ed-file" });
  refs.youtube = el("input", { class: "input", value: draft.youtube ? `https://youtu.be/${draft.youtube}` : "", placeholder: "貼上 YouTube 網址" });
  refs.offset = el("input", { class: "input input--num", type: "number", step: "0.01", value: String(draft.youtubeOffset || 0) });
  refs.url = el("input", { class: "input", value: draft.url, placeholder: "https://…/song.mp3（選用）" });
  refs.start = el("input", { class: "input input--time", value: lrc.formatTime(draft.startTime) });
  refs.end = el("input", { class: "input input--time", value: draft.endTime ? lrc.formatTime(draft.endTime) : "", placeholder: "播到底" });
  refs.preview = el("div", { class: "ed-preview" });
  refs.videoBox = el("div", { class: "ed-video hidden" });
  refs.playBtn = el("button", { class: "btn btn--primary", text: "▶" });
  refs.time = el("span", { class: "ed-time", text: "00:00.00 / 00:00.00" });
  refs.seek = el("input", { class: "ed-seek", type: "range", min: "0", max: "0", step: "0.01", value: "0" });
  refs.rate = el("select", { class: "input input--rate" }, el("option", { value: "1", text: "1x" }), el("option", { value: "0.75", text: "0.75x" }), el("option", { value: "0.5", text: "0.5x" }));
  refs.wave = el("canvas", { class: "ed-wave", height: "110" });
  refs.waveNote = el("div", { class: "muted ed-wave-note" });
  refs.calibrate = el("button", { class: "btn btn--small hidden", text: "🎯 選取句開唱時按這裡，對齊 YouTube" });
  refs.lines = el("div", { class: "ed-lines" });
  refs.issues = el("div", { class: "ed-issues" });
  refs.tapBtn = el("button", { class: "btn btn--small", text: "🥁 打拍子模式" });
  refs.tapHint = el("div", { class: "ed-tap-hint hidden", text: "打拍子中：播放歌曲，每句開唱時按 Space 記下時間並跳到下一句；Backspace 回上一句；Esc 結束" });
  refs.save = el("button", { class: "btn" + (isNew ? " btn--primary" : ""), text: "💾 儲存" });
  refs.heading = el("h2", { text: isNew ? "新增歌曲" : `編輯：${draft.title || "未命名"}` });

  container.replaceChildren(
    el(
      "div",
      { class: "ed-head" },
      el("button", { class: "btn btn--small", text: "← 返回題庫", onclick: () => close() }),
      refs.heading,
      el("span", { class: "spacer" }),
      el("span", { class: "muted", text: "快捷鍵：Space 播放・↑↓ 選句・[ ] 微調 ±0.05 秒・P 從這句播・T 試停" }),
      refs.save
    ),
    el(
      "div",
      { class: "ed-body" },
      el(
        "section",
        { class: "ed-left" },
        el("h3", { text: "歌曲資訊" }),
        field("歌名", refs.title),
        field("歌手", refs.artist),
        el("h3", { text: "音源" }),
        field(
          "本地檔案",
          refs.fileName,
          el("button", { class: "btn btn--small", text: "選擇音檔…", onclick: pickAudio }),
          el("button", { class: "btn btn--small", text: "清除", onclick: () => setField("filename", "") })
        ),
        field("YouTube", refs.youtube),
        field("YouTube 偏移", refs.offset, el("span", { class: "muted", text: "秒（YouTube 版本比歌詞時間晚多少）" })),
        field("音訊網址", refs.url),
        el("h3", { text: "試聽與對時" }),
        refs.preview,
        refs.videoBox,
        el(
          "div",
          { class: "ed-transport" },
          el("button", { class: "btn btn--small", text: "⏪ 5s", onclick: () => seekBy(-5) }),
          refs.playBtn,
          el("button", { class: "btn btn--small", text: "5s ⏩", onclick: () => seekBy(5) }),
          refs.rate,
          refs.time
        ),
        refs.seek,
        refs.wave,
        refs.waveNote,
        refs.calibrate,
        el("h3", { text: "播放範圍" }),
        field("開始", refs.start, el("button", { class: "btn btn--small", text: "設為目前時間", onclick: () => setRange("startTime") })),
        field("結束", refs.end, el("button", { class: "btn btn--small", text: "設為目前時間", onclick: () => setRange("endTime") }))
      ),
      el(
        "section",
        { class: "ed-right" },
        el(
          "div",
          { class: "ed-tools" },
          el("span", { class: "ed-tools__label", text: "歌詞" }),
          el("button", { class: "btn btn--small", text: "📋 貼上", onclick: pasteLyrics }),
          el("button", { class: "btn btn--small", text: "📄 匯入檔案", onclick: importLyricsFile }),
          el("button", { class: "btn btn--small", text: "🔍 線上搜尋（LRCLIB）", onclick: searchLrclib }),
          el("button", { class: "btn btn--small", text: "简→繁", title: "簡體轉繁體", onclick: toTraditional }),
          el("button", { class: "btn btn--small", text: "🧹 清掉作詞作曲", onclick: cleanCredits })
        ),
        el(
          "div",
          { class: "ed-tools" },
          el("span", { class: "ed-tools__label", text: "時間" }),
          refs.tapBtn,
          el("button", { class: "btn btn--small", text: "⇆ 全部平移", onclick: shiftAll }),
          el("button", { class: "btn btn--small", text: "↕ 依時間排序", onclick: sortLines }),
          el("button", { class: "btn btn--small", text: "＋ 新增一行", onclick: () => insertLine() })
        ),
        refs.tapHint,
        refs.lines,
        el("h3", { text: "檢查" }),
        refs.issues
      )
    )
  );

  // ---------- 欄位 ----------

  function setField(key, value) {
    draft[key] = value;
    markDirty();
    renderSources();
  }

  function renderSources() {
    refs.fileName.textContent = draft.filename ? draft.filename + (fileExists(draft.filename) ? "" : "（找不到檔案）") : "未設定";
    refs.fileName.classList.toggle("is-missing", !!draft.filename && !fileExists(draft.filename));

    const options = [];
    if (draft.filename && fileExists(draft.filename)) options.push(["file", "本地檔案"]);
    if (draft.youtube) options.push(["youtube", "YouTube"]);
    if (draft.url) options.push(["url", "音訊網址"]);
    if (!options.some(([t]) => t === ed.previewType)) ed.previewType = options[0]?.[0] || null;

    refs.preview.replaceChildren(
      el("span", { class: "muted", text: "試聽用：" }),
      ...(options.length
        ? options.map(([type, label]) =>
            el("button", {
              class: "btn btn--small" + (type === ed.previewType ? " btn--primary" : ""),
              text: label,
              onclick: () => {
                ed.previewType = type;
                renderSources();
              },
            })
          )
        : [el("span", { class: "muted", text: "先設定本地檔案或 YouTube 才能試聽與對時" })])
    );
    ensurePlayer();
  }

  refs.title.addEventListener("input", () => {
    draft.title = refs.title.value.trim();
    refs.heading.textContent = `編輯：${draft.title || "未命名"}`;
    markDirty();
  });
  refs.artist.addEventListener("input", () => {
    draft.artist = refs.artist.value.trim();
    markDirty();
  });
  refs.youtube.addEventListener("change", () => {
    const v = refs.youtube.value.trim();
    const id = v ? parseYouTubeId(v) : "";
    if (v && !id) {
      toast("看不懂這個 YouTube 網址", "error");
      return;
    }
    if (id) refs.youtube.value = `https://youtu.be/${id}`;
    setField("youtube", id || "");
  });
  refs.offset.addEventListener("change", () => {
    draft.youtubeOffset = round2(parseFloat(refs.offset.value) || 0);
    refs.offset.value = String(draft.youtubeOffset);
    if (ed.player?.kind === "youtube") ed.player.offset = draft.youtubeOffset;
    markDirty();
  });
  refs.url.addEventListener("change", () => setField("url", refs.url.value.trim()));
  for (const [key, input] of [["startTime", refs.start], ["endTime", refs.end]]) {
    input.addEventListener("change", () => {
      const v = input.value.trim();
      const t = v ? lrc.parseTimeText(v) : 0;
      if (t === null) {
        toast("時間格式要像 01:23.45", "error");
        input.value = draft[key] ? lrc.formatTime(draft[key]) : "";
        return;
      }
      draft[key] = round2(t);
      input.value = draft[key] || key === "startTime" ? lrc.formatTime(draft[key]) : "";
      markDirty();
    });
  }

  function setRange(key) {
    if (!ed.player) return;
    draft[key] = round2(ed.player.currentTime);
    (key === "startTime" ? refs.start : refs.end).value = lrc.formatTime(draft[key]);
    markDirty();
  }

  async function pickAudio() {
    try {
      const res = await ipcRenderer.invoke("audio:pick");
      if (!res) return;
      if (res.copied) toast(`已複製到 songs/：${res.filename}`);
      ed.peaks = null;
      ed.peaksFor = null;
      setField("filename", res.filename);
      ed.previewType = "file";
      renderSources();
    } catch (e) {
      toast(e.message, "error");
    }
  }

  // ---------- 播放器 ----------

  function previewSource() {
    if (ed.previewType === "file") return { type: "file", filename: draft.filename };
    if (ed.previewType === "youtube") return { type: "youtube", videoId: draft.youtube, offset: draft.youtubeOffset };
    if (ed.previewType === "url") return { type: "url", url: draft.url };
    return null;
  }

  function sourceKey(src) {
    return src ? JSON.stringify({ ...src, offset: undefined }) : "";
  }

  let playerKey = "";
  async function ensurePlayer() {
    const src = previewSource();
    const key = sourceKey(src);
    if (key === playerKey) return;
    playerKey = key;
    ed.player?.destroy();
    ed.player = null;
    refs.videoBox.classList.toggle("hidden", src?.type !== "youtube");
    refs.calibrate.classList.toggle("hidden", src?.type !== "youtube");
    if (!src) return;
    try {
      const bridgeUrl = src.type === "youtube" ? await ipcRenderer.invoke("bridge:url") : null;
      const p = createPlayer(src, {
        songsDir: library.songsDir(dataDir),
        videoContainer: refs.videoBox,
        bridgeUrl,
        startTime: draft.startTime,
      });
      ed.player = p;
      p.playbackRate = parseFloat(refs.rate.value);
      p.addEventListener("play", renderPlayButton);
      p.addEventListener("pause", renderPlayButton);
      p.addEventListener("ended", renderPlayButton);
      p.addEventListener("ready", () => {
        refs.seek.max = String(p.duration || 0);
        p.playbackRate = parseFloat(refs.rate.value);
      });
      p.addEventListener("error", (e) => toast(e.detail?.message || "播放失敗", "error"));
      if (p.kind === "audio") p.currentTime = draft.startTime;
    } catch (e) {
      toast(e.message, "error");
    }
    loadPeaks();
  }

  function renderPlayButton() {
    refs.playBtn.textContent = ed.player && !ed.player.paused ? "⏸" : "▶";
  }

  function togglePlay() {
    const p = ed.player;
    if (!p) return;
    if (p.paused) Promise.resolve(p.play()).catch(() => {});
    else p.pause();
  }

  function seekTo(t) {
    if (!ed.player) return;
    ed.player.currentTime = Math.max(0, t);
    ed.waveCenter = null;
  }

  function seekBy(d) {
    if (ed.player) seekTo(ed.player.currentTime + d);
  }

  function playFrom(t) {
    if (!ed.player) return;
    cancelTestStop();
    seekTo(Math.max(0, t));
    Promise.resolve(ed.player.play()).catch(() => {});
  }

  refs.playBtn.addEventListener("click", togglePlay);
  refs.rate.addEventListener("change", () => {
    if (ed.player) ed.player.playbackRate = parseFloat(refs.rate.value);
  });
  refs.seek.addEventListener("input", () => seekTo(parseFloat(refs.seek.value)));
  refs.calibrate.addEventListener("click", () => {
    const line = draft.lines[ed.selected];
    if (!ed.player || ed.player.kind !== "youtube" || !line || line.time === null) {
      toast("先選一句已有時間的歌詞，播放 YouTube，在那句開唱時按這個按鈕", "warning");
      return;
    }
    const ytTime = ed.player.currentTime + draft.youtubeOffset;
    draft.youtubeOffset = round2(ytTime - line.time);
    refs.offset.value = String(draft.youtubeOffset);
    ed.player.offset = draft.youtubeOffset;
    markDirty();
    toast(`YouTube 偏移設為 ${draft.youtubeOffset} 秒`);
  });

  // 試停：從停點前 3 秒播到停點，確認不會漏出答案
  function testStop(i) {
    const line = draft.lines[i];
    if (!ed.player || !line || line.time === null) return;
    if (!lrc.hasMask(line.text)) {
      toast("這句沒有遮字", "warning");
      return;
    }
    const stopAt = Math.max(0, line.time - STOP_LEAD);
    playFrom(stopAt - 3);
    ed.testStopAt = stopAt;
    ed.testTimer = setInterval(() => {
      const p = ed.player;
      if (!p || ed.testStopAt === null) return cancelTestStop();
      if (p.currentTime >= ed.testStopAt - 0.005) {
        p.pause();
        p.currentTime = ed.testStopAt;
        toast(`停在 ${lrc.formatTime(ed.testStopAt)}。聽到答案的第一個音就把時間調早；切掉太多前一句就調晚。`);
        cancelTestStop();
      }
    }, 5);
  }

  function cancelTestStop() {
    clearInterval(ed.testTimer);
    ed.testTimer = null;
    ed.testStopAt = null;
  }

  // ---------- 波形（只有本地檔案） ----------

  async function loadPeaks() {
    if (ed.previewType !== "file" || !draft.filename) {
      ed.peaks = null;
      refs.wave.classList.toggle("hidden", true);
      refs.waveNote.textContent = ed.previewType === "youtube" ? "YouTube 沒有波形，請用耳朵加「試停」對時。" : "";
      return;
    }
    refs.wave.classList.remove("hidden");
    if (ed.peaksFor === draft.filename && ed.peaks) return;
    const forFile = draft.filename;
    refs.waveNote.textContent = "分析波形中…";
    try {
      const buf = fs.readFileSync(path.join(library.songsDir(dataDir), forFile));
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      ctx.close();
      const step = Math.floor(audio.sampleRate / PEAKS_PER_SEC);
      const count = Math.ceil(audio.length / step);
      const peaks = new Float32Array(count);
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const data = audio.getChannelData(c);
        for (let i = 0; i < count; i++) {
          let max = 0;
          const end = Math.min(data.length, (i + 1) * step);
          for (let j = i * step; j < end; j++) {
            const v = Math.abs(data[j]);
            if (v > max) max = v;
          }
          if (max > peaks[i]) peaks[i] = max;
        }
      }
      if (draft.filename !== forFile) return;
      ed.peaks = peaks;
      ed.peaksFor = forFile;
      refs.waveNote.textContent = "點波形可把選取句的時間設到該位置。金線＝遮字句，紅虛線＝停點，藍線＝播放位置。";
    } catch (e) {
      refs.waveNote.textContent = `無法分析波形：${e.message}`;
    }
  }

  function waveRange() {
    const sel = draft.lines[ed.selected];
    const playing = ed.player && !ed.player.paused;
    let center = ed.waveCenter;
    if (center === null || playing) {
      center = playing ? ed.player.currentTime : sel?.time ?? ed.player?.currentTime ?? 0;
    }
    const start = Math.max(0, center - WAVE_SPAN / 2);
    return { start, end: start + WAVE_SPAN };
  }

  function drawWave() {
    const canvas = refs.wave;
    if (!ed.peaks || canvas.classList.contains("hidden")) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#0d0d0d";
    g.fillRect(0, 0, w, h);
    const { start, end } = waveRange();
    const x = (t) => ((t - start) / (end - start)) * w;

    // 播放範圍外變暗
    g.fillStyle = "#555";
    for (let px = 0; px < w; px++) {
      const t = start + (px / w) * (end - start);
      const amp = ed.peaks[Math.floor(t * PEAKS_PER_SEC)] || 0;
      const outside = t < draft.startTime || (draft.endTime > 0 && t > draft.endTime);
      g.fillStyle = outside ? "#333" : "#6b6b6b";
      const bh = Math.max(1, amp * (h - 10));
      g.fillRect(px, (h - bh) / 2, 1, bh);
    }
    // 秒數刻度
    g.fillStyle = "#777";
    g.font = "10px monospace";
    for (let s = Math.ceil(start); s < end; s++) {
      g.fillRect(x(s), h - 4, 1, 4);
      if (s % 2 === 0) g.fillText(lrc.formatTime(s).slice(0, 5), x(s) + 2, h - 6);
    }
    // 歌詞時間標記
    draft.lines.forEach((line, i) => {
      if (line.time === null || line.time < start || line.time > end) return;
      const masked = lrc.hasMask(line.text);
      g.fillStyle = i === ed.selected ? "#fff" : masked ? "#ffcc00" : "#888";
      g.fillRect(x(line.time) - (i === ed.selected ? 1 : 0), 0, i === ed.selected ? 3 : 1, h);
      if (masked) {
        g.strokeStyle = "#ff4444";
        g.setLineDash([4, 3]);
        g.beginPath();
        g.moveTo(x(line.time - STOP_LEAD) + 0.5, 0);
        g.lineTo(x(line.time - STOP_LEAD) + 0.5, h);
        g.stroke();
        g.setLineDash([]);
      }
    });
    if (ed.player) {
      g.fillStyle = "#44ccff";
      g.fillRect(x(ed.player.currentTime), 0, 2, h);
    }
  }

  refs.wave.addEventListener("click", (e) => {
    const line = draft.lines[ed.selected];
    if (!line) return;
    const rect = refs.wave.getBoundingClientRect();
    const { start, end } = waveRange();
    ed.waveCenter = (start + end) / 2;
    setLineTime(ed.selected, start + ((e.clientX - rect.left) / rect.width) * (end - start));
  });

  // ---------- 歌詞列 ----------

  function setLineTime(i, t) {
    const line = draft.lines[i];
    if (!line) return;
    line.time = t === null ? null : round2(Math.max(0, t));
    markDirty();
    renderLines();
  }

  function select(i, { scroll = true } = {}) {
    if (draft.lines.length === 0) {
      ed.selected = -1;
      return;
    }
    ed.selected = Math.max(0, Math.min(i, draft.lines.length - 1));
    ed.waveCenter = null;
    for (const row of refs.lines.children) row.classList.toggle("is-selected", Number(row.dataset.index) === ed.selected);
    if (scroll) refs.lines.children[ed.selected]?.scrollIntoView({ block: "nearest" });
  }

  function toggleMask(input) {
    const i = Number(input.dataset.index);
    const v = input.value;
    const a = input.selectionStart ?? 0;
    const b = input.selectionEnd ?? 0;
    if (b > a) {
      input.value = v.slice(0, a) + "*" + v.slice(a, b) + "*" + v.slice(b);
    } else {
      // 游標在 *…* 裡面：取消遮字
      const before = v.lastIndexOf("*", a - 1);
      const after = v.indexOf("*", a);
      const starsBefore = (v.slice(0, Math.max(0, before)).match(/\*/g) || []).length;
      if (before === -1 || after === -1 || starsBefore % 2 === 1) {
        toast("先在歌詞裡選取要遮的字，再按 ★", "warning");
        return;
      }
      input.value = v.slice(0, before) + v.slice(before + 1, after) + v.slice(after + 1);
    }
    draft.lines[i].text = input.value;
    markDirty();
    renderLines();
  }

  function renderLines() {
    const rows = draft.lines.map((line, i) => {
      const masked = lrc.hasMask(line.text);
      const timeInput = el("input", {
        class: "input input--time" + (line.time === null ? " is-empty" : ""),
        value: line.time === null ? "" : lrc.formatTime(line.time),
        placeholder: "--:--.--",
      });
      timeInput.addEventListener("change", () => {
        const v = timeInput.value.trim();
        const t = v ? lrc.parseTimeText(v) : null;
        if (v && t === null) {
          toast("時間格式要像 01:23.45", "error");
          timeInput.value = line.time === null ? "" : lrc.formatTime(line.time);
          return;
        }
        setLineTime(i, t);
      });
      const textInput = el("input", { class: "input ed-line__text", value: line.text });
      textInput.dataset.index = String(i);
      textInput.addEventListener("input", () => {
        line.text = textInput.value;
        row.classList.toggle("is-masked", lrc.hasMask(line.text));
        markDirty();
      });
      const row = el(
        "div",
        { class: "ed-line" + (masked ? " is-masked" : "") + (i === ed.selected ? " is-selected" : "") },
        timeInput,
        el("button", { class: "btn btn--small", text: "−", title: `早 ${NUDGE} 秒`, onclick: () => nudge(i, -NUDGE) }),
        el("button", { class: "btn btn--small", text: "+", title: `晚 ${NUDGE} 秒`, onclick: () => nudge(i, NUDGE) }),
        textInput,
        el("button", { class: "btn btn--small", text: "★", title: "選取文字後按：設為遮字（再按一次取消）", onmousedown: (e) => e.preventDefault(), onclick: () => toggleMask(textInput) }),
        el("button", { class: "btn btn--small", text: "▶", title: "從這句前 1 秒播放 (P)", onclick: () => line.time !== null && playFrom(line.time - 1) }),
        masked ? el("button", { class: "btn btn--small btn--danger", text: "🎯", title: "試停 (T)", onclick: () => testStop(i) }) : el("span", { class: "ed-line__pad" }),
        el("button", { class: "btn btn--small", text: "🗑", title: "刪除這行", onclick: () => deleteLine(i) })
      );
      row.dataset.index = String(i);
      row.addEventListener("mousedown", () => select(i, { scroll: false }));
      return row;
    });
    if (rows.length === 0) {
      rows.push(el("div", { class: "muted ed-empty", text: "還沒有歌詞。用上方「貼上」「匯入檔案」「線上搜尋」帶入，或按「新增一行」。" }));
    }
    refs.lines.replaceChildren(...rows);
  }

  function nudge(i, d) {
    const line = draft.lines[i];
    if (!line || line.time === null) return;
    select(i, { scroll: false });
    setLineTime(i, line.time + d);
  }

  function insertLine() {
    const at = ed.selected >= 0 ? ed.selected + 1 : draft.lines.length;
    const t = ed.player ? round2(ed.player.currentTime) : null;
    draft.lines.splice(at, 0, { time: t, text: "" });
    markDirty();
    renderLines();
    select(at);
    refs.lines.children[at]?.querySelector(".ed-line__text")?.focus();
  }

  function deleteLine(i) {
    draft.lines.splice(i, 1);
    markDirty();
    renderLines();
    select(Math.min(i, draft.lines.length - 1));
  }

  function sortLines() {
    draft.lines.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
    markDirty();
    renderLines();
  }

  async function shiftAll() {
    const v = await modal.promptText("全部平移", { label: "所有歌詞時間加上幾秒？（負數＝提早，例如 -0.5）", value: "0" });
    if (v === null) return;
    const d = parseFloat(v);
    if (!Number.isFinite(d) || d === 0) return;
    for (const line of draft.lines) if (line.time !== null) line.time = round2(Math.max(0, line.time + d));
    markDirty();
    renderLines();
    toast(`已平移 ${d > 0 ? "+" : ""}${d} 秒`);
  }

  // ---------- 打拍子 ----------

  function setTapMode(on) {
    ed.tapMode = on;
    refs.tapBtn.classList.toggle("btn--primary", on);
    refs.tapHint.classList.toggle("hidden", !on);
    if (on) {
      if (!ed.player) {
        toast("先設定音源才能打拍子", "warning");
        setTapMode(false);
        return;
      }
      if (ed.selected < 0) select(0);
      document.activeElement?.blur();
    }
  }

  function tap() {
    if (!ed.player || ed.selected < 0) return;
    setLineTime(ed.selected, ed.player.currentTime);
    if (ed.selected < draft.lines.length - 1) select(ed.selected + 1);
    else {
      toast("最後一句了，打拍子完成");
      setTapMode(false);
    }
  }

  refs.tapBtn.addEventListener("click", () => setTapMode(!ed.tapMode));

  // ---------- 歌詞匯入 ----------

  async function confirmReplace() {
    if (draft.lines.length === 0) return true;
    return modal.confirmDialog("取代歌詞", "目前的歌詞（含時間與遮字）會被取代，確定嗎？", { okLabel: "取代" });
  }

  function applyLyricsText(text, { clean = true } = {}) {
    let lines = lrc.looksLikeLRC(text) ? linesFromLrc(text.split(/\r?\n/)) : lrc.parsePlainLyrics(text);
    const before = lines.length;
    if (clean) lines = lines.filter((l) => !lrc.isCreditLine(l.text));
    draft.lines = lines;
    markDirty();
    renderLines();
    select(0);
    const timed = lines.filter((l) => l.time !== null).length;
    toast(
      `匯入 ${lines.length} 行` +
        (before > lines.length ? `（清掉 ${before - lines.length} 行作詞作曲等資訊）` : "") +
        (timed ? "" : "\n沒有時間，請用「打拍子模式」對時")
    );
  }

  async function pasteLyrics() {
    const area = el("textarea", { class: "input ed-paste", placeholder: "貼上 LRC（[00:12.34] 歌詞）或純文字歌詞（一行一句）" });
    const clean = el("input", { type: "checkbox", checked: "" });
    const body = el("div", {}, area, el("label", { class: "ed-check" }, clean, " 清掉作詞、作曲等製作資訊行"));
    const ok = await modal.open({
      title: "貼上歌詞",
      body,
      buttons: [
        { label: "取消", value: () => null },
        { label: "套用", primary: true, value: () => area.value },
      ],
    });
    if (!ok || !ok.trim() || !(await confirmReplace())) return;
    applyLyricsText(ok, { clean: clean.checked });
  }

  async function importLyricsFile() {
    const res = await ipcRenderer.invoke("lyrics:pick");
    if (!res || !(await confirmReplace())) return;
    applyLyricsText(res.text);
  }

  async function searchLrclib() {
    const track = el("input", { class: "input", value: draft.title, placeholder: "歌名" });
    const artist = el("input", { class: "input", value: draft.artist, placeholder: "歌手" });
    const results = el("div", { class: "lrclib-results" });
    const preview = el("pre", { class: "lrclib-preview muted", text: "搜尋後點選結果預覽" });
    let chosen = null;
    const duration = ed.previewType === "file" && ed.player ? ed.player.duration : 0;

    async function run() {
      results.replaceChildren(el("div", { class: "muted", text: "搜尋中…" }));
      try {
        let list = await ipcRenderer.invoke("lrclib:search", { track: track.value.trim(), artist: artist.value.trim() });
        if (duration) list = list.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
        if (!list.length) {
          results.replaceChildren(el("div", { class: "muted", text: "找不到，試試只填歌名，或換簡體字搜尋" }));
          return;
        }
        results.replaceChildren(
          ...list.map((r) => {
            const diff = duration ? Math.abs(r.duration - duration) : null;
            const item = el(
              "div",
              { class: "lrclib-item" },
              el("div", { text: `${r.track} — ${r.artist}` }),
              el(
                "div",
                { class: "muted" },
                `${r.album || ""}　${lrc.formatTime(r.duration).slice(0, 5)}　`,
                el("span", { class: "badge" + (r.synced ? " badge--file" : ""), text: r.synced ? "有時間" : r.plain ? "純文字" : "無歌詞" }),
                diff !== null ? el("span", { class: diff < 2 ? "ok" : "muted", text: diff < 2 ? "　✓ 長度相符" : `　長度差 ${diff.toFixed(0)} 秒` }) : null
              )
            );
            item.addEventListener("click", () => {
              chosen = r;
              for (const n of results.children) n.classList.toggle("selected", n === item);
              preview.textContent = (r.synced || r.plain || "（沒有歌詞）").split("\n").slice(0, 40).join("\n");
            });
            return item;
          })
        );
      } catch (e) {
        results.replaceChildren(el("div", { class: "is-error", text: `搜尋失敗：${e.message}` }));
      }
    }

    const body = el(
      "div",
      { class: "lrclib" },
      el("div", { class: "lrclib-form" }, track, artist, el("button", { class: "btn btn--primary", text: "搜尋", onclick: run })),
      el("div", { class: "lrclib-cols" }, results, preview),
      el("p", { class: "muted", text: "歌詞來自 LRCLIB 社群資料庫，時間不一定和你的音源版本一致，套用後用「全部平移」或打拍子修正。" })
    );
    if (track.value || artist.value) setTimeout(run);
    const ok = await modal.open({
      title: "線上搜尋歌詞（LRCLIB）",
      body,
      buttons: [
        { label: "取消", value: () => null },
        { label: "套用選取的歌詞", primary: true, value: () => chosen },
      ],
    });
    if (!ok) return;
    const text = ok.synced || ok.plain;
    if (!text) {
      toast("這筆沒有歌詞", "warning");
      return;
    }
    if (!(await confirmReplace())) return;
    if (!draft.artist && ok.artist) {
      draft.artist = ok.artist;
      refs.artist.value = ok.artist;
    }
    if (!draft.title && ok.track) {
      draft.title = ok.track;
      refs.title.value = ok.track;
    }
    applyLyricsText(text);
  }

  let converter = null;
  function toTraditional() {
    converter ||= require("opencc-js").Converter({ from: "cn", to: "tw" });
    let changed = 0;
    for (const line of draft.lines) {
      const t = converter(line.text);
      if (t !== line.text) changed++;
      line.text = t;
    }
    for (const [key, input] of [["title", refs.title], ["artist", refs.artist]]) {
      draft[key] = converter(draft[key]);
      input.value = draft[key];
    }
    markDirty();
    renderLines();
    toast(changed ? `轉換了 ${changed} 行` : "沒有需要轉換的字");
  }

  function cleanCredits() {
    const before = draft.lines.length;
    draft.lines = draft.lines.filter((l) => l.text.trim() && !lrc.isCreditLine(l.text));
    markDirty();
    renderLines();
    select(ed.selected);
    toast(`清掉 ${before - draft.lines.length} 行`);
  }

  // ---------- 檢查 ----------

  let checkTimer = null;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(renderIssues, 300);
  }

  function toSong() {
    return {
      ...draft,
      lrc: linesToLrc(draft.lines),
      title: draft.title.trim(),
    };
  }

  function renderIssues() {
    const issues = checkSong(toSong(), 0, { fileExists });
    const untimed = draft.lines.filter((l) => l.time === null).length;
    const items = issues.map((x) => el("div", { class: x.level === "error" ? "is-error" : "is-warning", text: `${x.level === "error" ? "❌" : "⚠️"} ${x.message}` }));
    if (untimed) items.unshift(el("div", { class: "is-warning", text: `⚠️ 還有 ${untimed} 行沒有時間（遊戲中不會顯示）` }));
    if (!items.length) items.push(el("div", { class: "ok", text: "✓ 沒有問題" }));
    refs.issues.replaceChildren(...items);
  }

  // ---------- 儲存／關閉 ----------

  function save() {
    const song = toSong();
    if (!song.title) {
      toast("請填歌名", "error");
      refs.title.focus();
      return false;
    }
    try {
      const fresh = library.readPlaylist(dataDir, playlistFile);
      const list = fresh.error ? songs.slice() : fresh.songs;
      if (isNew && ed.savedIndex === undefined) {
        list.push(song);
        ed.savedIndex = list.length - 1;
      } else {
        list[ed.savedIndex ?? index] = song;
      }
      library.writePlaylist(dataDir, playlistFile, list.map((s) => ({ ...s, lrc: s.lrc })));
      songs.splice(0, songs.length, ...list);
      ed.dirty = false;
      refs.save.classList.remove("btn--primary");
      toast(`已儲存「${song.title}」`);
      return true;
    } catch (e) {
      toast(`儲存失敗：${e.message}`, "error");
      return false;
    }
  }

  refs.save.addEventListener("click", save);

  async function close() {
    if (ed.dirty) {
      const choice = await modal.open({
        title: "還沒儲存",
        body: el("p", { class: "modal__text", text: "這首歌有修改還沒儲存。" }),
        buttons: [
          { label: "取消", value: () => null },
          { label: "不儲存", danger: true, value: () => "discard" },
          { label: "儲存並返回", primary: true, value: () => "save" },
        ],
      });
      if (!choice) return;
      if (choice === "save" && !save()) return;
    }
    destroy();
    onClose();
  }

  function destroy() {
    cancelTestStop();
    cancelAnimationFrame(ed.raf);
    clearTimeout(checkTimer);
    document.removeEventListener("keydown", onKey);
    ed.player?.destroy();
    ed.player = null;
    container.replaceChildren();
    if (current === api) current = null;
  }

  // ---------- 鍵盤與畫面更新 ----------

  function onKey(e) {
    if (document.querySelector(".modal-backdrop")) return;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
    if (ed.tapMode) {
      if (e.code === "Space") {
        e.preventDefault();
        tap();
        return;
      }
      if (e.code === "Backspace") {
        e.preventDefault();
        select(ed.selected - 1);
        return;
      }
      if (e.code === "Escape") {
        setTapMode(false);
        return;
      }
    }
    if (typing) {
      if (e.code === "Escape") e.target.blur();
      return;
    }
    switch (e.code) {
      case "Space":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowUp":
        e.preventDefault();
        select(ed.selected - 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        select(ed.selected + 1);
        break;
      case "BracketLeft":
        nudge(ed.selected, -NUDGE);
        break;
      case "BracketRight":
        nudge(ed.selected, NUDGE);
        break;
      case "KeyP": {
        const line = draft.lines[ed.selected];
        if (line?.time !== null && line) playFrom(line.time - 1);
        break;
      }
      case "KeyT":
        testStop(ed.selected);
        break;
      case "KeyS":
        if (e.ctrlKey) {
          e.preventDefault();
          save();
        }
        break;
    }
  }
  document.addEventListener("keydown", onKey);

  let lastPlayingRow = -1;
  function frame() {
    const p = ed.player;
    if (p) {
      const t = p.currentTime;
      const dur = p.duration;
      refs.time.textContent = `${lrc.formatTime(t)} / ${lrc.formatTime(dur || 0)}`;
      if (dur && refs.seek.max !== String(dur)) refs.seek.max = String(dur);
      if (document.activeElement !== refs.seek) refs.seek.value = String(t);
      // 標示正在唱的那一句
      let playing = -1;
      draft.lines.forEach((l, i) => {
        if (l.time !== null && l.time <= t && (playing === -1 || l.time >= draft.lines[playing].time)) playing = i;
      });
      if (playing !== lastPlayingRow) {
        lastPlayingRow = playing;
        for (const row of refs.lines.children) row.classList.toggle("is-playing", Number(row.dataset.index) === playing);
      }
    }
    drawWave();
    ed.raf = requestAnimationFrame(frame);
  }

  const api = { destroy, close, save, draft, ed, refs, tap, testStop, applyLyricsText };
  current = api;

  renderSources();
  renderLines();
  renderIssues();
  frame();
  return api;
}

module.exports = { openEditor, linesFromLrc, linesToLrc };
