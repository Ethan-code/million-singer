// 舞台：遊戲引擎與觀眾畫面。
// 指令來源：控制台、手機遙控（經主程式轉送 "game:command"）與本視窗的鍵盤。
// 每次狀態改變都把快照送回主程式（"game:state"），控制台與手機據此顯示答案與進度。
const fs = require("fs");
const path = require("path");
const { ipcRenderer } = require("electron");
const lrc = require("../shared/lrc");
const { resolveSource, STOP_LEAD } = require("../shared/song");
const { checkPlaylist } = require("../shared/checker");
const library = require("../shared/library");
const { createPlayer } = require("../player/players");
const { toast, dismiss } = require("../ui/toast");
const { createGuard } = require("../ui/guard");

// ==========================================
// 常數
// ==========================================

// 停點：遮字句在「歌詞時間 - STOP_LEAD」停下（STOP_LEAD 定義在 shared/song.js）。
// 輪詢負責畫面更新；離停點剩 PRECISE_WINDOW 秒內改用單次計時器精準停下。
const SYNC_INTERVAL = 50; // 毫秒
const PRECISE_WINDOW = 0.3; // 秒
// 計時器觸發時若還差超過這個量（例如緩衝造成延遲），就重新排程。
const STOP_TOLERANCE = 0.005; // 秒
const WARNING_SECONDS = 5;
const REVEAL_HOLD_MS = 1500;
const TITLE_SHOW_MS = 5000;
const STATE_PUBLISH_MS = 200; // 播放中回報進度的間隔

const RoundState = {
  IDLE: "IDLE",
  FLOW: "FLOW",
  LOCKED: "LOCKED",
  REVEALING: "REVEALING",
  FINISHED: "FINISHED",
};

const RevealType = {
  CORRECT: "correct", // 答對
  ANSWER: "answer", // 公布答案（答錯或沒人答）
};

// ==========================================
// 狀態
// ==========================================

const state = {
  active: false,
  dataDir: null,
  bridgeUrl: null,
  prefer: "local",
  playlistName: "",
  playlist: [],
  roundIssues: {}, // round（從 1 起算）→ issues
  teams: [], // [{ name, score }]
  scoreboardVisible: true,

  currentTrackIndex: 0,
  source: null,
  roundState: RoundState.IDLE,
  revealType: null,
  currentIndex: -1,
  lyricsData: [],
  config: { startTime: 0, endTime: 0 },
  isTitleVisible: false,
  isPlaying: false,
  lastError: null,
};

let player = null;
let syncTimer = null;
let stopTimer = null;
let revealTimer = null;
let titleTimer = null;
let lastPublish = 0;

const $ = (id) => document.getElementById(id);
const els = {
  waiting: $("waiting"),
  game: $("game"),
  videoBox: $("video-box"),
  scoreboard: $("scoreboard"),
  titlePanel: $("title-panel"),
  titleText: $("title-text"),
  warningOverlay: $("warning-overlay"),
  warningIcon: $("warning-icon"),
  round: $("display-round"),
  status: $("display-status"),
  idleMsg: $("idle-msg"),
  idleRound: $("idle-round-text"),
  lyricContainer: $("lyric-container"),
  lyricLine: $("lyric-line"),
  menu: $("menu-container"),
  visualizer: $("visualizer"),
  btns: {
    prev: $("btn-prev"),
    next: $("btn-next"),
    toggle: $("btn-toggle"),
    reveal: $("btn-reveal"),
    answer: $("btn-answer"),
    reset: $("btn-reset"),
    exit: $("btn-exit"),
  },
};

// ==========================================
// 開始遊戲
// ==========================================

function startGame(init) {
  state.dataDir = init.dataDir;
  state.bridgeUrl = init.bridgeUrl;
  state.prefer = init.prefer || "local";
  state.playlistName = init.playlistName || "";
  state.teams = (init.teams || []).map((name) => ({ name, score: 0 }));
  state.scoreboardVisible = state.teams.length > 0;

  const { raw, songs, error } = library.readPlaylist(init.dataDir, init.playlistFile);
  if (error || songs.length === 0) {
    toast(`讀取題庫失敗：${error || "題庫是空的"}`, "error");
    return;
  }
  const fileExists = (f) => library.songFileExists(state.dataDir, f);
  state.roundIssues = {};
  for (const issue of checkPlaylist(raw, { fileExists, prefer: state.prefer })) {
    (state.roundIssues[issue.round] ||= []).push(issue);
  }
  state.playlist = songs;
  state.active = true;
  els.waiting.classList.add("hidden");
  els.game.classList.remove("hidden");
  loadSong(0);
}

// ==========================================
// 播放控制
// ==========================================

function destroyPlayer() {
  stopSync();
  if (player) {
    player.destroy();
    player = null;
  }
  els.videoBox.replaceChildren();
}

function loadSong(index) {
  if (index < 0 || index >= state.playlist.length) return;
  destroyPlayer();
  clearRoundTimers();

  state.currentTrackIndex = index;
  const song = state.playlist[index];
  state.config = { startTime: song.startTime, endTime: song.endTime };
  state.lyricsData = lrc.parseLRC(song.lrc).lines.map((line) => ({
    time: line.time,
    rawText: line.text,
    hasMask: lrc.hasMask(line.text),
    isAnswered: false,
    revealType: null,
    stopAt: Math.max(0, line.time - STOP_LEAD),
  }));
  state.roundState = RoundState.IDLE;
  state.revealType = null;
  state.currentIndex = -1;
  state.isTitleVisible = false;
  state.isPlaying = false;
  state.lastError = null;

  const fileExists = (f) => library.songFileExists(state.dataDir, f);
  state.source = resolveSource(song, { fileExists, prefer: state.prefer });
  const isVideo = state.source?.type === "youtube";
  els.game.classList.toggle("is-video", isVideo);
  els.videoBox.classList.toggle("hidden", !isVideo);

  if (!state.source) {
    reportError(`Round ${index + 1} 沒有可播放的音源`);
  } else {
    try {
      player = createPlayer(state.source, {
        songsDir: library.songsDir(state.dataDir),
        videoContainer: els.videoBox,
        bridgeUrl: state.bridgeUrl,
        startTime: state.config.startTime,
      });
      bindPlayer(player);
      if (player.kind === "audio") player.currentTime = state.config.startTime;
    } catch (e) {
      reportError(e.message);
    }
  }

  buildMenu();
  updateUI();
}

function bindPlayer(p) {
  p.addEventListener("play", () => {
    if (p !== player) return;
    state.isPlaying = true;
    if (state.roundState === RoundState.IDLE) state.roundState = RoundState.FLOW;
    startSync();
    updateUI();
  });
  p.addEventListener("pause", () => {
    if (p !== player) return;
    state.isPlaying = false;
    stopSync();
    setWarning(false);
    updateUI();
  });
  p.addEventListener("ended", () => {
    if (p !== player) return;
    state.isPlaying = false;
    state.roundState = RoundState.FINISHED;
    stopSync();
    updateUI();
  });
  p.addEventListener("error", (e) => {
    if (p !== player) return;
    reportError(`Round ${state.currentTrackIndex + 1}：${e.detail?.message || "播放失敗"}`);
  });
}

function reportError(message) {
  state.lastError = message;
  toast(message, "error");
  publishState(true);
}

// play() 若隨即被 pause()（例如一開播就碰到停點）會以 AbortError 結束，屬正常情況
function playAudio() {
  if (!player) return;
  Promise.resolve(player.play()).catch((e) => {
    if (e?.name !== "AbortError") console.error(e);
  });
}

function isRunning() {
  return state.roundState === RoundState.FLOW || state.roundState === RoundState.REVEALING;
}

function togglePlay() {
  if (!player || state.roundState === RoundState.LOCKED || state.roundState === RoundState.FINISHED) {
    return;
  }
  if (player.paused) {
    // YouTube 第一次播放前，確保從開始時間播
    if (state.roundState === RoundState.IDLE && player.kind === "youtube") {
      player.currentTime = state.config.startTime;
    }
    playAudio();
  } else player.pause();
}

function startSync() {
  stopSync();
  syncTimer = setInterval(syncTick, SYNC_INTERVAL);
  syncTick(); // 從停點附近接續播放時，不等第一個間隔
}

function stopSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (stopTimer) clearTimeout(stopTimer);
  syncTimer = null;
  stopTimer = null;
}

// 遮字句尚未答對前，以停點而非歌詞時間判斷是否已唱到
function lineStartTime(line) {
  return line.hasMask && !line.isAnswered ? line.stopAt : line.time;
}

// 下一個要停的點：未答的遮字停點或片段結束，取較早者
function findNextStop(t) {
  let next = null;
  state.lyricsData.forEach((line, index) => {
    if (!line.hasMask || line.isAnswered || line.stopAt <= t) return;
    if (!next || line.stopAt < next.time) next = { type: "mask", time: line.stopAt, index };
  });
  const end = state.config.endTime;
  if (end > t && (!next || end < next.time)) next = { type: "end", time: end };
  return next;
}

function schedulePreciseStop(t) {
  if (stopTimer) return;
  const next = findNextStop(t);
  if (!next || next.time - t > PRECISE_WINDOW) return;

  const delayMs = ((next.time - t) * 1000) / (player.playbackRate || 1);
  stopTimer = setTimeout(() => {
    stopTimer = null;
    if (!player || player.paused || !isRunning()) return;
    const now = player.currentTime;
    if (next.time - now > STOP_TOLERANCE) {
      schedulePreciseStop(now); // 還沒到（例如曾經卡頓），重新排程
      return;
    }
    if (next.type === "mask") lockAt(next.index);
    else finishRound();
  }, delayMs);
}

function lockAt(index) {
  const line = state.lyricsData[index];
  state.currentIndex = index;
  state.roundState = RoundState.LOCKED;
  const t = player.currentTime;
  player.pause();
  // 對齊到停點，揭曉後一律從同一位置接續。
  // 只修正小誤差；從遮字句之後才開始播的情況不往回跳。
  if (Math.abs(t - line.stopAt) < 0.5) player.currentTime = line.stopAt;
  updateUI();
}

function finishRound() {
  player?.pause();
  state.roundState = RoundState.FINISHED;
  updateUI();
}

function syncTick() {
  if (!player || state.roundState === RoundState.LOCKED || player.paused) return;
  const t = player.currentTime;

  // 備援：計時器沒趕上（例如從停點之後開始播）時，照輪詢結果處理
  if (state.config.endTime > 0 && t >= state.config.endTime) {
    finishRound();
    return;
  }

  const next = findNextStop(t);
  setWarning(next !== null && next.type === "mask" && next.time - t <= WARNING_SECONDS);

  let activeIdx = -1;
  state.lyricsData.forEach((line, i) => {
    if (t >= lineStartTime(line)) activeIdx = i;
  });
  if (activeIdx !== -1 && activeIdx !== state.currentIndex) {
    const target = state.lyricsData[activeIdx];
    if (target.hasMask && !target.isAnswered) {
      lockAt(activeIdx);
      return;
    }
    state.currentIndex = activeIdx;
    updateUI();
  }

  schedulePreciseStop(t);
  publishState(false);
}

function clearRoundTimers() {
  clearTimeout(revealTimer);
  clearTimeout(titleTimer);
  revealTimer = null;
  titleTimer = null;
}

// 遮字停住時揭曉：答對或公布答案，揭曉後繼續播放
function reveal(type) {
  if (state.roundState !== RoundState.LOCKED) return;
  const line = state.lyricsData[state.currentIndex];
  line.isAnswered = true;
  line.revealType = type;
  state.roundState = RoundState.REVEALING;
  state.revealType = type;
  showTitle();
  playAudio();
  updateUI();

  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (state.roundState === RoundState.REVEALING) {
      state.roundState = RoundState.FLOW;
      updateUI();
    }
  }, REVEAL_HOLD_MS);
}

// 歌名面板滑入，一段時間後自動收起
function showTitle() {
  state.isTitleVisible = true;
  clearTimeout(titleTimer);
  titleTimer = setTimeout(() => {
    state.isTitleVisible = false;
    updateUI();
  }, TITLE_SHOW_MS);
}

function changeScore(teamIndex, delta) {
  const team = state.teams[teamIndex];
  if (!team || !Number.isFinite(delta)) return;
  team.score += delta;
  renderScoreboard(teamIndex);
  publishState(true);
}

function endGame() {
  destroyPlayer();
  ipcRenderer.send("game:end");
}

// ==========================================
// 指令（控制台／手機／鍵盤共用）
// ==========================================

function runCommand(cmd) {
  if (!state.active) return;
  switch (cmd.cmd) {
    case "toggle":
      togglePlay();
      break;
    case "correct":
      reveal(RevealType.CORRECT);
      break;
    case "answer":
      reveal(RevealType.ANSWER);
      break;
    case "reset":
      loadSong(state.currentTrackIndex);
      break;
    case "next":
      loadSong(state.currentTrackIndex + 1);
      break;
    case "prev":
      loadSong(state.currentTrackIndex - 1);
      break;
    case "goto":
      loadSong(Number(cmd.index));
      break;
    case "score":
      changeScore(Number(cmd.team), Number(cmd.delta));
      break;
    case "scoreboard":
      state.scoreboardVisible = cmd.visible ?? !state.scoreboardVisible;
      renderScoreboard();
      publishState(true);
      break;
    case "end":
      endGame();
      break;
  }
}

// 鍵盤防誤觸：歌曲進行中，切歌／重來／結束要按兩次
const guard = createGuard({
  onPrompt: (label) => toast(label, "warning", { key: "guard", duration: 2000 }),
  onCancel: () => dismiss("guard"),
});

const GUARDED = {
  end: "結束遊戲",
  reset: "重來這一首",
  next: "下一首",
  prev: "上一首",
};

function guarded(cmd, keyLabel = "按鈕") {
  const inProgress = state.roundState !== RoundState.IDLE;
  guard.run(
    cmd,
    `再按一次 ${keyLabel} ${GUARDED[cmd]}`,
    () => {
      dismiss("guard");
      runCommand({ cmd });
    },
    inProgress || cmd === "end"
  );
}

function handleKey(e) {
  if (!state.active) return;
  switch (e.code) {
    case "Space":
      e.preventDefault();
      runCommand({ cmd: "toggle" });
      break;
    case "Enter":
      e.preventDefault();
      runCommand({ cmd: "correct" });
      break;
    case "KeyA":
      runCommand({ cmd: "answer" });
      break;
    case "KeyR":
      guarded("reset", "R");
      break;
    case "ArrowRight":
      guarded("next", "→");
      break;
    case "ArrowLeft":
      guarded("prev", "←");
      break;
    case "KeyH":
      guarded("end", "H");
      break;
    case "KeyS":
      runCommand({ cmd: "scoreboard" });
      break;
    case "KeyF":
    case "F11":
      e.preventDefault();
      ipcRenderer.send("stage:fullscreen");
      break;
    case "Escape":
      ipcRenderer.send("stage:fullscreen", false);
      break;
  }
}

function bindEvents() {
  ipcRenderer.on("game:init", (e, init) => startGame(init));
  ipcRenderer.on("game:command", (e, cmd) => runCommand(cmd));
  window.addEventListener("keydown", handleKey);

  els.btns.toggle.addEventListener("click", () => runCommand({ cmd: "toggle" }));
  els.btns.reveal.addEventListener("click", () => runCommand({ cmd: "correct" }));
  els.btns.answer.addEventListener("click", () => runCommand({ cmd: "answer" }));
  els.btns.reset.addEventListener("click", () => guarded("reset"));
  els.btns.prev.addEventListener("click", () => guarded("prev"));
  els.btns.next.addEventListener("click", () => guarded("next"));
  els.btns.exit.addEventListener("click", () => guarded("end"));

  els.round.addEventListener("click", (e) => {
    e.stopPropagation();
    els.menu.classList.toggle("visible");
  });
  document.addEventListener("click", () => els.menu.classList.remove("visible"));
}

// ==========================================
// 畫面
// ==========================================

const STATUS_VIEW = {
  [RoundState.IDLE]: { text: "🟢 READY", className: "status--ready" },
  [RoundState.FLOW]: { text: "▶ PLAYING", className: "status--playing" },
  [RoundState.LOCKED]: { text: "⏸ WAITING...", className: "status--waiting" },
  [RoundState.REVEALING]: {
    [RevealType.CORRECT]: { text: "✨ CORRECT!", className: "status--correct" },
    [RevealType.ANSWER]: { text: "📖 ANSWER", className: "status--answer" },
  },
  [RoundState.FINISHED]: { text: "🏁 FINISHED", className: "status--finished" },
};

function setWarning(active) {
  els.warningOverlay.classList.toggle("active", active);
  els.warningIcon.classList.toggle("active", active);
}

function updateUI() {
  const roundLabel = `ROUND ${state.currentTrackIndex + 1}`;
  const isIdle = state.roundState === RoundState.IDLE;
  const isLocked = state.roundState === RoundState.LOCKED;

  els.round.textContent = roundLabel;
  const view =
    state.roundState === RoundState.REVEALING
      ? STATUS_VIEW[RoundState.REVEALING][state.revealType]
      : STATUS_VIEW[state.roundState];
  els.status.className = "header__status " + view.className;
  els.status.textContent = view.text;

  els.visualizer.classList.toggle("active", state.isPlaying || isLocked);
  els.visualizer.classList.toggle("playing", state.isPlaying);

  els.titleText.textContent = state.playlist[state.currentTrackIndex]?.title || "";
  els.titlePanel.classList.toggle("visible", state.isTitleVisible && !isIdle);

  els.idleMsg.classList.toggle("hidden", !isIdle);
  els.lyricContainer.classList.toggle("hidden", isIdle);
  if (isIdle) els.idleRound.textContent = roundLabel;
  if (state.roundState !== RoundState.FLOW) setWarning(false);

  const line = state.lyricsData[state.currentIndex];
  els.lyricLine.innerHTML = line ? renderLyricLine(line) : "";

  els.btns.toggle.textContent = isIdle
    ? "▶ 開始 (Space)"
    : state.isPlaying
      ? "⏸ 暫停 (Space)"
      : "⏯ 播放 (Space)";
  els.btns.toggle.classList.toggle(
    "btn--disabled",
    !player || isLocked || state.roundState === RoundState.FINISHED
  );
  els.btns.reveal.classList.toggle("btn--disabled", !isLocked);
  els.btns.answer.classList.toggle("btn--disabled", !isLocked);

  renderScoreboard();
  publishState(true);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const MASK_STAR = '<span class="mask-symbol">★</span>';

function maskAnswer(answer) {
  return lrc
    .maskStarCounts(answer)
    .map((n) => MASK_STAR.repeat(n))
    .join(" ");
}

function renderLyricLine(line) {
  const text = escapeHtml(line.rawText);
  if (!line.hasMask) return text;
  return text.replace(/\*(.*?)\*/g, (match, answer) => {
    if (!line.isAnswered) return `<span class="magic-word">${maskAnswer(answer)}</span>`;
    const classes = ["magic-word"];
    if (line.revealType === RevealType.ANSWER) classes.push("magic-word--answer");
    if (state.roundState === RoundState.REVEALING) classes.push("is-revealing");
    return `<span class="${classes.join(" ")}">${answer}</span>`;
  });
}

function renderScoreboard(bumpIndex = -1) {
  const show = state.teams.length > 0 && state.scoreboardVisible;
  els.scoreboard.classList.toggle("hidden", !show);
  if (!show) return;
  const cards = state.teams.map((team, i) => {
    const card = document.createElement("div");
    card.className = "scoreboard__team";
    const name = document.createElement("div");
    name.className = "scoreboard__name";
    name.textContent = team.name;
    const score = document.createElement("div");
    score.className = "scoreboard__score" + (i === bumpIndex ? " is-bump" : "");
    score.textContent = team.score;
    card.append(name, score);
    return card;
  });
  els.scoreboard.replaceChildren(...cards);
}

function buildMenu() {
  const items = state.playlist.map((song, idx) => {
    const div = document.createElement("div");
    div.className = "menu__item";
    div.classList.toggle("active", idx === state.currentTrackIndex);
    const flagged = state.roundIssues[idx + 1]?.length > 0;
    div.textContent = `Round ${idx + 1}${flagged ? " ⚠️" : ""}`;
    div.onclick = () => {
      if (state.roundState === RoundState.IDLE) loadSong(idx);
      else guard.run(`goto-${idx}`, `再點一次跳到 Round ${idx + 1}`, () => loadSong(idx));
    };
    return div;
  });
  els.menu.replaceChildren(...items);
}

// ==========================================
// 回報狀態給控制台與手機
// ==========================================

// 焦點遮字：停住時是當前這句，否則是下一個未答的遮字句
function focusMask(t) {
  if (state.roundState === RoundState.LOCKED) {
    const line = state.lyricsData[state.currentIndex];
    return line ? { line, index: state.currentIndex } : null;
  }
  let found = null;
  state.lyricsData.forEach((line, index) => {
    if (found || !line.hasMask || line.isAnswered || line.stopAt < t - 0.01) return;
    found = { line, index };
  });
  return found;
}

function snapshot() {
  const t = player ? player.currentTime : state.config.startTime;
  const current = state.lyricsData[state.currentIndex];
  const focus = focusMask(t);
  const masks = state.lyricsData.filter((l) => l.hasMask);
  return {
    active: state.active,
    playlistName: state.playlistName,
    roundIndex: state.currentTrackIndex,
    roundCount: state.playlist.length,
    rounds: state.playlist.map((s, i) => ({
      title: s.title,
      artist: s.artist,
      issues: (state.roundIssues[i + 1] || []).map((x) => x.message),
    })),
    title: state.playlist[state.currentTrackIndex]?.title || "",
    artist: state.playlist[state.currentTrackIndex]?.artist || "",
    roundState: state.roundState,
    revealType: state.revealType,
    isPlaying: state.isPlaying,
    time: t,
    duration: player?.duration || 0,
    startTime: state.config.startTime,
    endTime: state.config.endTime,
    sourceType: state.source?.type || null,
    currentLine: current
      ? { text: current.rawText, hasMask: current.hasMask, isAnswered: current.isAnswered }
      : null,
    focusMask: focus
      ? {
          text: focus.line.rawText,
          answers: lrc.getMaskAnswers(focus.line.rawText),
          stopAt: focus.line.stopAt,
          inSeconds: Math.max(0, focus.line.stopAt - t),
          isCurrent: state.roundState === RoundState.LOCKED,
        }
      : null,
    maskCount: masks.length,
    maskAnswered: masks.filter((l) => l.isAnswered).length,
    teams: state.teams,
    scoreboardVisible: state.scoreboardVisible,
    lastError: state.lastError,
  };
}

function publishState(force) {
  const now = performance.now();
  if (!force && now - lastPublish < STATE_PUBLISH_MS) return;
  lastPublish = now;
  ipcRenderer.send("game:state", snapshot());
}

bindEvents();
