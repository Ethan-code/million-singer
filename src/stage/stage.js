// 舞台：遊戲引擎與觀眾畫面。設計理由見 docs/game-design.md。
// 指令來源：控制台、手機遙控（經主程式轉送 "game:command"）與本視窗的鍵盤。
// 每次狀態改變都把快照送回主程式（"game:state"），控制台與手機據此顯示答案與進度。
const { ipcRenderer } = require("electron");
const lrc = require("../shared/lrc");
const { resolveSource, STOP_LEAD } = require("../shared/song");
const { checkPlaylist } = require("../shared/checker");
const library = require("../shared/library");
const { createPlayer } = require("../player/players");
const { toast, dismiss } = require("../ui/toast");
const { createGuard } = require("../ui/guard");
const { createScene } = require("./scene3d");
const { createSfx } = require("./sfx");

// ==========================================
// 常數
// ==========================================

// 停點：遮字句在「歌詞時間 - STOP_LEAD」停下（STOP_LEAD 定義在 shared/song.js）。
// 輪詢負責畫面更新；離停點剩 PRECISE_WINDOW 秒內改用單次計時器精準停下。
const SYNC_INTERVAL = 50; // 毫秒
const PRECISE_WINDOW = 0.3; // 秒
const STOP_TOLERANCE = 0.005; // 秒
const WARNING_SECONDS = 5;
const COUNTDOWN_SECONDS = 3;
const REVEAL_HOLD_MS = 2200;
const TITLE_SHOW_MS = 5000;
const STATE_PUBLISH_MS = 200;
const POINTS_PER_CHAR = 100;
const TILE_FLIP_GAP = 0.12; // 秒
// KTV 逐字變色：每個字大約唱多久（LRC 只有句首時間，用估算）
const SECONDS_PER_UNIT = 0.42;

const RoundState = {
  IDLE: "IDLE",
  FLOW: "FLOW",
  LOCKED: "LOCKED",
  REVEALING: "REVEALING",
  FINISHED: "FINISHED",
};

const RevealType = {
  CORRECT: "correct",
  ANSWER: "answer",
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
  roundIssues: {},
  teams: [], // [{ name, score }]
  turn: -1, // 輪到哪一隊（沒有隊伍時 -1）
  scoreboardVisible: true,
  resultsVisible: false,

  currentTrackIndex: 0,
  source: null,
  roundState: RoundState.IDLE,
  revealType: null,
  lastAward: null, // { team, points }
  currentIndex: -1,
  lyricsData: [],
  config: { startTime: 0, endTime: 0 },
  isTitleVisible: false,
  isPlaying: false,
  countdown: 0,
  lastError: null,
};

let player = null;
let syncTimer = null;
let stopTimer = null;
let revealTimer = null;
let resumeTimer = null;
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
  flash: $("flash"),
  round: $("display-round"),
  status: $("display-status"),
  idle: $("idle"),
  idleRound: $("idle-round"),
  idleSub: $("idle-sub"),
  ktv: $("ktv"),
  slots: [$("ktv-a"), $("ktv-b")],
  turn: $("turn"),
  turnTeam: $("turn-team"),
  turnPoints: $("turn-points"),
  countdown: $("countdown"),
  floats: $("floats"),
  results: $("results"),
  podium: $("podium"),
  menu: $("menu-container"),
  visualizer: $("visualizer"),
  visualizerBars: [...document.querySelectorAll(".visualizer__bar")],
  btns: {
    prev: $("btn-prev"),
    next: $("btn-next"),
    toggle: $("btn-toggle"),
    reveal: $("btn-reveal"),
    answer: $("btn-answer"),
    hint: $("btn-hint"),
    replay: $("btn-replay"),
    reset: $("btn-reset"),
    exit: $("btn-exit"),
  },
};

// ==========================================
// 歌詞資料
// ==========================================

// 把一句歌詞拆成顯示單位：一般字、遮字牌（中文一字一張，英文一個單字一張）
function splitUnits(text) {
  const units = [];
  for (const part of String(text).split(/(\*.*?\*)/)) {
    const m = /^\*(.*)\*$/.exec(part);
    if (m && m[1]) {
      for (const word of m[1].split(" ")) {
        if (!word) continue;
        const pieces = /^[\x00-\xff]*$/.test(word) ? [word] : [...word];
        pieces.forEach((p) => units.push({ text: p, masked: true }));
        units.push({ text: " ", space: true });
      }
      if (units.at(-1)?.space) units.pop();
    } else {
      for (const ch of part) units.push(ch === " " ? { text: " ", space: true } : { text: ch, masked: false });
    }
  }
  return units;
}

function buildLyrics(song) {
  return lrc.parseLRC(song.lrc).lines.map((line) => {
    const units = splitUnits(line.text);
    const maskUnits = units.filter((u) => u.masked).length;
    return {
      time: line.time,
      rawText: line.text,
      units,
      hasMask: maskUnits > 0,
      maskUnits,
      hinted: 0, // 被提示翻開的牌數
      isAnswered: false,
      revealType: null,
      stopAt: Math.max(0, line.time - STOP_LEAD),
    };
  });
}

function linePoints(line) {
  return Math.max(0, line.maskUnits - line.hinted) * POINTS_PER_CHAR;
}

// ==========================================
// 開始遊戲
// ==========================================

function startGame(init) {
  state.dataDir = init.dataDir;
  state.bridgeUrl = init.bridgeUrl;
  state.prefer = init.prefer || "local";
  state.playlistName = init.playlistName || "";
  state.teams = (init.teams || []).map((name) => ({ name, score: 0 }));
  state.turn = state.teams.length ? 0 : -1;
  state.scoreboardVisible = state.teams.length > 0;
  state.resultsVisible = false;
  els.results.classList.add("hidden");

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
  analyser = null;
  if (player) {
    player.destroy();
    player = null;
  }
  els.videoBox.replaceChildren();
}

function loadSong(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.playlist.length) return;
  destroyPlayer();
  clearRoundTimers();
  sfx.stopRoll();

  state.currentTrackIndex = index;
  const song = state.playlist[index];
  state.config = { startTime: song.startTime, endTime: song.endTime };
  state.lyricsData = buildLyrics(song);
  state.roundState = RoundState.IDLE;
  state.revealType = null;
  state.lastAward = null;
  state.currentIndex = -1;
  state.isTitleVisible = false;
  state.isPlaying = false;
  state.lastError = null;
  setCountdown(0);
  if (state.resultsVisible) showResults(false);
  resetKtv();

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
      if (player.kind === "audio") {
        player.currentTime = state.config.startTime;
        attachAnalyser(player);
      }
    } catch (e) {
      reportError(e.message);
    }
  }

  sfx.whoosh();
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
    setCountdown(0);
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
  if (!player || state.roundState === RoundState.LOCKED || state.roundState === RoundState.FINISHED) return;
  if (player.paused) {
    if (state.roundState === RoundState.IDLE && player.kind === "youtube") {
      player.currentTime = state.config.startTime;
    }
    playAudio();
  } else player.pause();
}

function startSync() {
  stopSync();
  syncTimer = setInterval(syncTick, SYNC_INTERVAL);
  syncTick();
}

function stopSync() {
  if (syncTimer) clearInterval(syncTimer);
  if (stopTimer) clearTimeout(stopTimer);
  syncTimer = null;
  stopTimer = null;
}

// 遮字句一律以停點判斷是否已唱到。揭曉後從停點接續播放，
// 若改回歌詞時間，前 0.1 秒會被判成上一句，歌詞跳回去、翻牌動畫被打斷。
function lineStartTime(line) {
  return line.hasMask ? line.stopAt : line.time;
}

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
      schedulePreciseStop(now);
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
  if (Math.abs(t - line.stopAt) < 0.5) player.currentTime = line.stopAt;
  setCountdown(0);
  sfx.lock();
  scene?.shake(0.25);
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

  if (state.config.endTime > 0 && t >= state.config.endTime) {
    finishRound();
    return;
  }

  const next = findNextStop(t);
  const toMask = next?.type === "mask" ? next.time - t : Infinity;
  const flowing = state.roundState === RoundState.FLOW;
  setWarning(flowing && toMask <= WARNING_SECONDS);
  setCountdown(flowing && toMask <= COUNTDOWN_SECONDS ? Math.ceil(toMask) : 0);

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
  for (const t of [revealTimer, resumeTimer, titleTimer]) clearTimeout(t);
  revealTimer = resumeTimer = titleTimer = null;
}

// ---------- 判定 ----------

function reveal(type) {
  if (state.roundState !== RoundState.LOCKED) return;
  const line = state.lyricsData[state.currentIndex];
  const points = linePoints(line);
  line.isAnswered = true;
  line.revealType = type;
  state.roundState = RoundState.REVEALING;
  state.revealType = type;

  const flipped = flipTiles(type);
  if (type === RevealType.CORRECT) {
    sfx.correct();
    scene?.burst(0xffdd55);
    scene?.shake(0.5);
    if (state.turn >= 0 && points > 0) award(state.turn, points);
    else state.lastAward = null;
  } else {
    sfx.wrong();
    state.lastAward = null;
  }
  for (let i = 0; i < flipped; i++) sfx.flip(i);
  flash(type);
  if (state.teams.length) state.turn = (state.turn + 1) % state.teams.length;

  showTitle();
  // 牌翻完再接著唱，讓全場看清楚答案
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (state.roundState === RoundState.REVEALING) playAudio();
  }, Math.min(1500, 400 + flipped * TILE_FLIP_GAP * 1000));
  updateUI();

  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (state.roundState === RoundState.REVEALING) {
      state.roundState = RoundState.FLOW;
      updateUI();
    }
  }, REVEAL_HOLD_MS);
}

function award(teamIndex, points) {
  state.teams[teamIndex].score += points;
  state.lastAward = { team: teamIndex, points };
  floatScore(`+${points}`, teamIndex);
  setTimeout(() => {
    sfx.coin();
    renderScoreboard(teamIndex);
  }, 800);
}

// 提示：翻開下一張牌，這張不計分；至少留一張
function hint() {
  if (state.roundState !== RoundState.LOCKED) return;
  const line = state.lyricsData[state.currentIndex];
  if (line.hinted >= line.maskUnits - 1) {
    toast("只剩最後一個字，不能再提示", "warning", { key: "hint" });
    return;
  }
  const tile = currentTiles()[line.hinted];
  line.hinted++;
  tile?.classList.add("is-flipped", "is-hinted");
  sfx.hint();
  updateUI();
}

// 重聽：從前一句重播到停點，不扣分
function replay() {
  if (state.roundState !== RoundState.LOCKED || !player) return;
  const idx = state.currentIndex;
  const prev = state.lyricsData[idx - 1];
  const from = prev ? Math.max(state.config.startTime, prev.time - 0.3) : state.config.startTime;
  sfx.stopRoll();
  state.currentIndex = prev ? idx - 1 : -1;
  state.roundState = RoundState.FLOW;
  player.currentTime = from;
  playAudio();
  updateUI();
}

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
  if (!team || !Number.isFinite(delta) || delta === 0) return;
  team.score += delta;
  floatScore(delta > 0 ? `+${delta}` : String(delta), teamIndex);
  renderScoreboard(teamIndex);
  publishState(true);
}

function setTurn(teamIndex) {
  if (!Number.isInteger(teamIndex) || !state.teams[teamIndex]) return;
  state.turn = teamIndex;
  updateUI();
}

function showResults(visible) {
  state.resultsVisible = visible;
  if (visible) {
    player?.pause();
    sfx.stopRoll();
    renderPodium();
    sfx.fanfare();
    const colors = [0xffdd55, 0xff3fa4, 0x44ccff, 0xffffff];
    colors.forEach((c, i) => setTimeout(() => state.resultsVisible && scene?.burst(c), 500 + i * 700));
  }
  els.results.classList.toggle("hidden", !visible);
  els.game.classList.toggle("is-results", visible);
  updateMood();
  publishState(true);
}

function endGame() {
  sfx.stopRoll();
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
    case "hint":
      hint();
      break;
    case "replay":
      replay();
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
    case "turn":
      setTurn(Number(cmd.team));
      break;
    case "scoreboard":
      state.scoreboardVisible = cmd.visible ?? !state.scoreboardVisible;
      renderScoreboard();
      publishState(true);
      break;
    case "results":
      showResults(cmd.visible ?? !state.resultsVisible);
      break;
    case "mute":
      sfx.setMuted(cmd.muted ?? !sfx.muted);
      toast(sfx.muted ? "🔇 音效關閉" : "🔊 音效開啟", "info", { key: "mute", duration: 1500 });
      publishState(true);
      break;
    case "end":
      endGame();
      break;
  }
}

const guard = createGuard({
  onPrompt: (label) => toast(label, "warning", { key: "guard", duration: 2000 }),
  onCancel: () => dismiss("guard"),
});

const GUARDED = { end: "結束遊戲", reset: "重來這一首", next: "下一首", prev: "上一首" };

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
    case "KeyI":
      runCommand({ cmd: "hint" });
      break;
    case "KeyB":
      runCommand({ cmd: "replay" });
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
    case "KeyP":
      runCommand({ cmd: "results" });
      break;
    case "KeyM":
      runCommand({ cmd: "mute" });
      break;
    case "Digit1":
    case "Digit2":
    case "Digit3":
    case "Digit4":
    case "Digit5":
    case "Digit6":
      runCommand({ cmd: "turn", team: Number(e.code.slice(5)) - 1 });
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
  ipcRenderer.on("game:init", (e, init) => init && startGame(init));
  ipcRenderer.on("game:command", (e, cmd) => runCommand(cmd));
  window.addEventListener("keydown", handleKey);

  els.btns.toggle.addEventListener("click", () => runCommand({ cmd: "toggle" }));
  els.btns.reveal.addEventListener("click", () => runCommand({ cmd: "correct" }));
  els.btns.answer.addEventListener("click", () => runCommand({ cmd: "answer" }));
  els.btns.hint.addEventListener("click", () => runCommand({ cmd: "hint" }));
  els.btns.replay.addEventListener("click", () => runCommand({ cmd: "replay" }));
  els.btns.reset.addEventListener("click", () => guarded("reset"));
  els.btns.prev.addEventListener("click", () => guarded("prev"));
  els.btns.next.addEventListener("click", () => guarded("next"));
  els.btns.exit.addEventListener("click", () => guarded("end"));
  els.results.addEventListener("click", () => runCommand({ cmd: "results", visible: false }));

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
  [RoundState.IDLE]: { text: "READY", className: "status--ready" },
  [RoundState.FLOW]: { text: "PLAYING", className: "status--playing" },
  [RoundState.LOCKED]: { text: "YOUR TURN", className: "status--waiting" },
  [RoundState.REVEALING]: {
    [RevealType.CORRECT]: { text: "CORRECT!", className: "status--correct" },
    [RevealType.ANSWER]: { text: "ANSWER", className: "status--answer" },
  },
  [RoundState.FINISHED]: { text: "FINISHED", className: "status--finished" },
};

let warningOn = false;
function setWarning(active) {
  if (active === warningOn) return;
  warningOn = active;
  els.warningOverlay.classList.toggle("active", active);
  updateMood();
  renderTurn();
}

function setCountdown(n) {
  if (n === state.countdown) return;
  state.countdown = n;
  els.countdown.classList.toggle("hidden", n <= 0);
  if (n > 0) {
    els.countdown.textContent = String(n);
    restartAnimation(els.countdown);
    sfx.tick(n === 1);
  }
  publishState(true);
}

function updateUI() {
  const isIdle = state.roundState === RoundState.IDLE;
  const isLocked = state.roundState === RoundState.LOCKED;
  const total = state.playlist.length;

  els.round.textContent = `ROUND ${state.currentTrackIndex + 1} / ${total}`;
  const view =
    state.roundState === RoundState.REVEALING
      ? STATUS_VIEW[RoundState.REVEALING][state.revealType]
      : STATUS_VIEW[state.roundState];
  els.status.className = "header__status " + view.className;
  els.status.textContent = view.text;

  els.visualizer.classList.toggle("active", state.isPlaying || isLocked);
  els.visualizer.classList.toggle("playing", state.isPlaying);
  els.visualizer.classList.toggle("is-fake", !analyser);

  els.titleText.textContent = state.playlist[state.currentTrackIndex]?.title || "";
  els.titlePanel.classList.toggle("visible", state.isTitleVisible && !isIdle);

  // Round 開場
  els.idle.classList.toggle("hidden", !isIdle);
  els.ktv.classList.toggle("hidden", isIdle);
  if (isIdle) {
    const n = String(state.currentTrackIndex + 1);
    if (els.idleRound.textContent !== n) {
      els.idleRound.textContent = n;
      restartAnimation(els.idle);
    }
    const first = state.turn >= 0 ? `　第一棒：${state.teams[state.turn].name}` : "";
    els.idleSub.textContent = `${n} / ${total}${first}`;
  }
  if (state.roundState !== RoundState.FLOW) setWarning(false);

  renderKtv();
  renderTurn();

  els.btns.toggle.textContent = isIdle ? "▶ 開始" : state.isPlaying ? "⏸ 暫停" : "⏯ 播放";
  els.btns.toggle.classList.toggle("btn--disabled", !player || isLocked || state.roundState === RoundState.FINISHED);
  for (const b of ["reveal", "answer", "hint", "replay"]) els.btns[b].classList.toggle("btn--disabled", !isLocked);

  renderScoreboard();
  updateMood();
  publishState(true);
}

function restartAnimation(node) {
  node.style.animation = "none";
  void node.offsetWidth;
  node.style.animation = "";
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- KTV 兩行歌詞 ----------
// 偶數句在上排（靠左）、奇數句在下排（靠右），像 KTV 一樣輪替。
// 顯示「正在唱的句子」與「下一句」；遮字句因此會提前一句以空白牌出現。
const slotLine = [-2, -2]; // 每排目前顯示第幾句

function resetKtv() {
  slotLine[0] = slotLine[1] = -2;
  sungKey = "";
  els.slots.forEach((s) => s.replaceChildren());
}

function buildLineNode(line) {
  const node = document.createElement("div");
  node.className = "ktv-text";
  let tileIndex = 0;
  for (const u of line.units) {
    if (u.space) {
      node.appendChild(document.createTextNode(" "));
      continue;
    }
    if (!u.masked) {
      const span = document.createElement("span");
      span.className = "u";
      span.textContent = u.text;
      node.appendChild(span);
      continue;
    }
    const hinted = !line.isAnswered && tileIndex < line.hinted;
    const flipped = line.isAnswered || hinted;
    const tile = document.createElement("span");
    tile.className =
      "u tile" +
      (u.text.length > 1 ? " tile--word" : "") +
      (flipped ? " is-flipped" : "") +
      (hinted ? " is-hinted" : "") +
      (line.revealType === RevealType.ANSWER ? " tile--answer" : "");
    if (u.text.length > 1) tile.style.minWidth = `${Math.max(2, u.text.length * 0.6)}em`;
    tile.innerHTML = `<span class="tile__inner"><span class="tile__face tile__front">★</span><span class="tile__face tile__back">${escapeHtml(u.text)}</span></span>`;
    node.appendChild(tile);
    tileIndex++;
  }
  const len = line.units.filter((u) => !u.space).length;
  node.dataset.size = len > 14 ? "xs" : len > 10 ? "s" : len > 7 ? "m" : "l";
  return node;
}

function renderKtv() {
  const cur = state.currentIndex;
  const lines = state.lyricsData;
  const show = cur >= 0 ? [cur, cur + 1] : [0];
  for (const idx of show) {
    if (!lines[idx]) continue;
    const slot = idx % 2;
    if (slotLine[slot] !== idx) {
      slotLine[slot] = idx;
      const el = els.slots[slot];
      el.replaceChildren(buildLineNode(lines[idx]));
      restartAnimation(el);
    }
  }
  // 最後一句時，另一排不留舊歌詞
  if (cur >= 0 && !lines[cur + 1]) {
    const other = (cur + 1) % 2;
    if (slotLine[other] !== cur) {
      slotLine[other] = -2;
      els.slots[other].replaceChildren();
    }
  }
  els.slots.forEach((el, slot) => {
    const idx = slotLine[slot];
    const isCurrent = idx === cur && cur >= 0;
    el.classList.toggle("is-current", isCurrent);
    el.classList.toggle("is-next", !isCurrent && idx >= 0);
    el.classList.toggle("is-locked", isCurrent && state.roundState === RoundState.LOCKED);
    el.classList.toggle("is-masked", idx >= 0 && !!lines[idx]?.hasMask && !lines[idx].isAnswered);
  });
}

function currentSlotEl() {
  const slot = state.currentIndex % 2;
  return state.currentIndex >= 0 && slotLine[slot] === state.currentIndex ? els.slots[slot] : null;
}

function currentTiles() {
  return [...(currentSlotEl()?.querySelectorAll(".tile") || [])];
}

function flipTiles(type) {
  let n = 0;
  for (const tile of currentTiles()) {
    if (type === RevealType.ANSWER) tile.classList.add("tile--answer");
    if (tile.classList.contains("is-flipped")) continue;
    tile.querySelector(".tile__inner").style.transitionDelay = `${n * TILE_FLIP_GAP}s`;
    tile.classList.add("is-flipped");
    n++;
  }
  return n;
}

// KTV 逐字變色：依句子長度估算唱到第幾個字
let sungKey = "";
function updateSung(t) {
  const cur = state.currentIndex;
  const line = state.lyricsData[cur];
  const el = currentSlotEl();
  if (!line || !el || state.roundState === RoundState.LOCKED || state.roundState === RoundState.IDLE) return;
  const units = el.querySelectorAll(".u");
  const next = state.lyricsData[cur + 1];
  const natural = Math.max(1.2, units.length * SECONDS_PER_UNIT);
  const span = next ? Math.min(next.time - line.time, natural) : natural;
  const progress = Math.max(0, Math.min(1, (t - line.time) / Math.max(0.3, span)));
  const count = Math.round(progress * units.length);
  const key = `${state.currentTrackIndex}:${cur}:${count}`;
  if (key === sungKey) return;
  sungKey = key;
  units.forEach((u, i) => u.classList.toggle("is-sung", i < count));
}

// ---------- 輪到誰 ----------
function renderTurn() {
  const isLocked = state.roundState === RoundState.LOCKED;
  const upcoming = warningOn && player ? findNextStop(player.currentTime) : null;
  const show = isLocked || upcoming?.type === "mask";
  els.turn.classList.toggle("hidden", !show);
  els.turn.classList.toggle("is-locked", isLocked);
  if (!show) return;
  const line = isLocked ? state.lyricsData[state.currentIndex] : state.lyricsData[upcoming.index];
  const team = state.turn >= 0 ? state.teams[state.turn].name : "";
  els.turnTeam.textContent = isLocked ? (team ? `${team} 接唱！` : "接唱！") : team ? `下一句：${team}` : "準備接唱…";
  els.turnPoints.textContent = line && state.teams.length ? `${linePoints(line)} 分` : "";
}

function flash(type) {
  els.flash.className = "flash";
  void els.flash.offsetWidth;
  els.flash.className = `flash go go--${type}`;
}

// 分數飛向該隊的計分卡
function floatScore(text, teamIndex) {
  const card = els.scoreboard.children[teamIndex];
  const node = document.createElement("div");
  node.className = "float-score" + (text.startsWith("-") ? " is-minus" : "");
  node.textContent = text;
  els.floats.appendChild(node);
  const from = { x: window.innerWidth / 2, y: window.innerHeight * 0.42 };
  const rect = card?.getBoundingClientRect();
  const to = rect ? { x: rect.left + rect.width / 2, y: rect.top } : { x: from.x, y: from.y - 200 };
  node.animate(
    [
      { transform: `translate(${from.x}px, ${from.y}px) translate(-50%, -50%) scale(0.4)`, opacity: 0 },
      { transform: `translate(${from.x}px, ${from.y - 80}px) translate(-50%, -50%) scale(1.5)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${to.x}px, ${to.y}px) translate(-50%, -50%) scale(0.5)`, opacity: 0.3 },
    ],
    { duration: 1000, easing: "cubic-bezier(0.5, 0, 0.3, 1)" }
  ).onfinish = () => node.remove();
}

function renderScoreboard(bumpIndex = -1) {
  const show = state.teams.length > 0 && state.scoreboardVisible;
  els.scoreboard.classList.toggle("hidden", !show);
  if (!show) return;
  const top = Math.max(...state.teams.map((x) => x.score));
  const cards = state.teams.map((team, i) => {
    const card = document.createElement("div");
    card.className =
      "scoreboard__team" + (team.score === top && top > 0 ? " is-leader" : "") + (i === state.turn ? " is-turn" : "");
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

// 頒獎台：依分數排名，冠軍在中間最高
function renderPodium() {
  const ranked = state.teams.map((t) => ({ ...t })).sort((a, b) => b.score - a.score);
  if (ranked.length === 0) {
    els.podium.innerHTML = '<div class="podium__empty">🎉 謝謝大家！</div>';
    return;
  }
  const order = ranked.length >= 3 ? [ranked[1], ranked[0], ranked[2], ...ranked.slice(3)] : ranked.length === 2 ? [ranked[1], ranked[0]] : ranked;
  els.podium.replaceChildren(
    ...order.map((t) => {
      const rank = ranked.indexOf(t) + 1;
      const col = document.createElement("div");
      col.className = `podium__col podium__col--${Math.min(rank, 4)}`;
      col.style.animationDelay = `${(ranked.length - rank) * 0.45}s`;
      col.innerHTML = `
        <div class="podium__name">${rank === 1 ? "👑 " : ""}${escapeHtml(t.name)}</div>
        <div class="podium__score">${t.score}</div>
        <div class="podium__block"><span>${rank}</span></div>`;
      return col;
    })
  );
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
    countdown: state.countdown,
    currentLine: current ? { text: current.rawText, hasMask: current.hasMask, isAnswered: current.isAnswered } : null,
    focusMask: focus
      ? {
          text: focus.line.rawText,
          answers: lrc.getMaskAnswers(focus.line.rawText),
          stopAt: focus.line.stopAt,
          inSeconds: Math.max(0, focus.line.stopAt - t),
          isCurrent: state.roundState === RoundState.LOCKED,
          points: linePoints(focus.line),
          hinted: focus.line.hinted,
          units: focus.line.maskUnits,
        }
      : null,
    maskCount: masks.length,
    maskAnswered: masks.filter((l) => l.isAnswered).length,
    teams: state.teams,
    turn: state.turn,
    lastAward: state.lastAward,
    scoreboardVisible: state.scoreboardVisible,
    resultsVisible: state.resultsVisible,
    sfxMuted: sfx.muted,
    lastError: state.lastError,
  };
}

function publishState(force) {
  const now = performance.now();
  if (!force && now - lastPublish < STATE_PUBLISH_MS) return;
  lastPublish = now;
  ipcRenderer.send("game:state", snapshot());
}

// ==========================================
// 3D 場景、音效與音樂律動
// ==========================================

let scene = null;
try {
  scene = createScene(document.getElementById("scene"));
} catch (e) {
  console.error("3D 場景無法啟動，改用純黑背景", e);
}

let audioCtx = null;
let analyser = null;
let freq = null;
const getAudioContext = () => (audioCtx ||= new AudioContext());
const sfx = createSfx(getAudioContext);

function attachAnalyser(p) {
  try {
    analyser = p.attachAnalyser(getAudioContext());
    freq = new Uint8Array(analyser.frequencyBinCount);
  } catch (e) {
    console.error("無法分析音樂頻譜", e);
    analyser = null;
  }
}

function updateMood() {
  if (!scene) return;
  if (state.resultsVisible) {
    scene.setMood("results");
    return;
  }
  const mood = {
    [RoundState.IDLE]: "idle",
    [RoundState.FLOW]: warningOn ? "warning" : "flow",
    [RoundState.LOCKED]: "locked",
    [RoundState.REVEALING]: state.revealType === RevealType.ANSWER ? "answer" : "correct",
    [RoundState.FINISHED]: "finished",
  }[state.roundState];
  scene.setMood(mood);
}

function frame() {
  const bars = els.visualizerBars;
  if (analyser && player?.kind === "audio" && state.isPlaying) {
    analyser.getByteFrequencyData(freq);
    const bins = freq.length * 0.7;
    let total = 0;
    bars.forEach((bar, i) => {
      const from = Math.floor((i / bars.length) ** 1.6 * bins);
      const to = Math.max(from + 1, Math.floor(((i + 1) / bars.length) ** 1.6 * bins));
      let sum = 0;
      for (let j = from; j < to; j++) sum += freq[j];
      const v = sum / (to - from) / 255;
      total += v;
      bar.style.transform = `scaleY(${Math.max(0.08, v).toFixed(3)})`;
    });
    scene?.setLevel((total / bars.length) * 1.6);
  } else {
    if (analyser) bars.forEach((bar) => (bar.style.transform = ""));
    scene?.setLevel(state.isPlaying ? 0.35 : 0);
  }
  if (player && state.active) updateSung(player.currentTime);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

bindEvents();
