const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { ipcRenderer } = require("electron");
const lrc = require("./src/shared/lrc");
const { normalizeSong, resolveSource } = require("./src/shared/song");
const { checkPlaylist, summarize } = require("./src/shared/checker");
const { toast, dismiss } = require("./src/ui/toast");
const { createGuard } = require("./src/ui/guard");

// ==========================================
// 狀態
// ==========================================

const RoundState = {
  IDLE: "IDLE",
  FLOW: "FLOW",
  LOCKED: "LOCKED",
  REVEALING: "REVEALING",
  FINISHED: "FINISHED",
};

const state = {
  // 資料夾（由 main process 決定，見 main.js）
  dataDir: null,
  dataDirOk: false,
  dataDirError: null,
  // 題庫選擇
  availableFiles: [],
  selectionIndex: -1,
  selectedFile: null,
  // 檢查有問題時，要再按一次開始才進遊戲
  confirmFile: null,
  roundIssues: {}, // round（從 1 起算）→ issues
  // 遊戲
  playlist: [],
  currentTrackIndex: 0,
  roundState: RoundState.IDLE,
  currentIndex: -1,
  lyricsData: [],
  config: { startTime: 0, endTime: 0 },
  isTitleVisible: false,
  isPlaying: false,
  revealType: null,
};

// 停點：遮字句在「歌詞時間 - STOP_LEAD」停下，抵銷聲音輸出緩衝與 LRC 誤差。
// 寧可早停切掉前一句尾巴，也不要晚停漏出答案。
const STOP_LEAD = 0.1; // 秒
// 輪詢負責畫面更新；離停點剩 PRECISE_WINDOW 秒內改用單次計時器精準停下。
const SYNC_INTERVAL = 50; // 毫秒
const PRECISE_WINDOW = 0.3; // 秒
// 計時器觸發時若還差超過這個量（例如緩衝造成延遲），就重新排程。
const STOP_TOLERANCE = 0.005; // 秒

// 揭曉後狀態列停留時間、歌名面板顯示時間
const REVEAL_HOLD_MS = 1500;
const TITLE_SHOW_MS = 5000;

const RevealType = {
  CORRECT: "correct", // 答對
  ANSWER: "answer", // 公布答案（答錯或沒人答）
};

let syncTimer = null;
let stopTimer = null;
let revealTimer = null;
let titleTimer = null;

const $ = (id) => document.getElementById(id);

const els = {
  screens: {
    start: $("screen-start"),
    game: $("screen-game"),
  },
  audio: $("audioPlayer"),
  status: $("load-status"),
  checkList: $("check-list"),
  playlistList: $("playlist-container"),
  dataDirPath: $("data-dir-path"),
  titlePanel: $("title-panel"),
  titleText: $("title-text"),
  warningOverlay: $("warning-overlay"),
  warningIcon: $("warning-icon"),
  displays: {
    round: $("display-round"),
    status: $("display-status"),
    idleMsg: $("idle-msg"),
    idleRound: $("idle-round-text"),
    lyricContainer: $("lyric-container"),
    lyricLine: $("lyric-line"),
    menu: $("menu-container"),
    visualizer: $("visualizer"),
  },
  btns: {
    start: $("btn-start-game"),
    refresh: $("btn-refresh"),
    openDir: $("btn-open-dir"),
    changeDir: $("btn-change-dir"),
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
// 資料夾與路徑
// ==========================================

const PathHelper = {
  playlistsDir: () => path.join(state.dataDir, "playlists"),
  songsDir: () => path.join(state.dataDir, "songs"),
  playlistFile: (filename) => path.join(PathHelper.playlistsDir(), filename),
  songFile: (filename) => path.join(PathHelper.songsDir(), filename),
};

function applyDataDirInfo(info) {
  state.dataDir = info.dir;
  state.dataDirOk = info.ok;
  state.dataDirError = info.error || null;
  els.dataDirPath.textContent = info.dir;
  els.dataDirPath.title = info.dir;
}

async function reloadDataDir() {
  applyDataDirInfo(await ipcRenderer.invoke("data-dir:get"));
  scanPlaylists();
}

async function changeDataDir() {
  const info = await ipcRenderer.invoke("data-dir:choose");
  if (!info) return; // 使用者取消
  applyDataDirInfo(info);
  scanPlaylists();
}

function openDataDir() {
  if (state.dataDirOk) ipcRenderer.invoke("data-dir:open");
}

// ==========================================
// 開始畫面：題庫選擇
// ==========================================

function showListMessage(text, isError = false) {
  const div = document.createElement("div");
  div.className =
    "playlist-list__msg" + (isError ? " playlist-list__msg--error" : "");
  div.textContent = text;
  els.playlistList.replaceChildren(div);
}

function scanPlaylists() {
  els.playlistList.replaceChildren();
  els.status.textContent = "";
  state.selectedFile = null;
  state.availableFiles = [];
  state.selectionIndex = -1;
  clearCheckList();
  els.btns.start.classList.add("btn--disabled");

  if (!state.dataDirOk) {
    const reason =
      state.dataDirError === "not-found"
        ? "找不到資料夾"
        : "無法使用資料夾：" + state.dataDirError;
    showListMessage(reason + "，請按下方「變更」重新選擇", true);
    return;
  }

  let files;
  try {
    files = fs
      .readdirSync(PathHelper.playlistsDir())
      .filter((file) => file.toLowerCase().endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch (e) {
    console.error(e);
    showListMessage("掃描失敗：" + e.message, true);
    return;
  }

  if (files.length === 0) {
    showListMessage("playlists 資料夾是空的 (需放入 .json)");
    return;
  }

  state.availableFiles = files;
  files.forEach((file, index) => {
    const div = document.createElement("div");
    div.className = "playlist-item";
    div.textContent = file.replace(/\.json$/i, "");
    div.addEventListener("click", () => selectPlaylistByIndex(index));
    els.playlistList.appendChild(div);
  });
}

function selectPlaylistByIndex(index) {
  const count = state.availableFiles.length;
  if (count === 0) return;
  index = Math.max(0, Math.min(index, count - 1));

  if (state.selectedFile !== state.availableFiles[index]) clearCheckList();
  state.selectionIndex = index;
  state.selectedFile = state.availableFiles[index];
  const items = els.playlistList.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("selected", i === index);
  }
  items[index].scrollIntoView({ block: "nearest", behavior: "smooth" });
  els.btns.start.classList.remove("btn--disabled");
}

const songFileExists = (filename) =>
  fs.existsSync(PathHelper.songFile(filename));

function clearCheckList() {
  state.confirmFile = null;
  els.checkList.replaceChildren();
  els.checkList.classList.add("hidden");
}

function showCheckList(issues) {
  const items = issues.map((issue) => {
    const li = document.createElement("li");
    li.className = issue.level === "error" ? "is-error" : "is-warning";
    const where = issue.round > 0 ? `Round ${issue.round}：` : "";
    li.textContent = `${issue.level === "error" ? "❌" : "⚠️"} ${where}${issue.message}`;
    return li;
  });
  const hint = document.createElement("li");
  hint.className = "check-list__hint";
  hint.textContent = "再按一次「開始遊戲」照樣開始，有問題的 Round 會標 ⚠️";
  els.checkList.replaceChildren(...items, hint);
  els.checkList.classList.remove("hidden");
}

function loadSelectedPlaylist() {
  if (!state.selectedFile) return;
  const file = state.selectedFile;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(PathHelper.playlistFile(file), "utf-8"));
  } catch (e) {
    toast(`讀取題庫失敗：${e.message}`, "error");
    return;
  }

  const issues = checkPlaylist(data, { fileExists: songFileExists });
  const { errors } = summarize(issues);
  // 題庫本身壞掉（不是陣列或空的）沒辦法玩
  if (issues.some((i) => i.round === 0)) {
    showCheckList(issues);
    els.checkList.lastChild.textContent = "請修正題庫後再試";
    return;
  }
  if (issues.length > 0 && state.confirmFile !== file) {
    state.confirmFile = file;
    showCheckList(issues);
    toast(
      errors > 0 ? `題庫有 ${errors} 個錯誤，請確認` : "題庫有警告，請確認",
      errors > 0 ? "error" : "warning",
      { key: "check", duration: 4000 }
    );
    return;
  }

  state.roundIssues = {};
  for (const issue of issues) {
    (state.roundIssues[issue.round] ||= []).push(issue);
  }
  clearCheckList();
  dismiss("check");
  state.playlist = data.map(normalizeSong);
  switchScreen("game");
  loadSong(0);
}

// ==========================================
// 畫面切換與事件
// ==========================================

function switchScreen(screenName) {
  Object.values(els.screens).forEach((el) => el.classList.add("hidden"));
  els.screens[screenName].classList.remove("hidden");
}

function isScreenVisible(screenName) {
  return !els.screens[screenName].classList.contains("hidden");
}

function goHome() {
  guard.clear();
  stopSync();
  clearRoundTimers();
  els.audio.pause();
  switchScreen("start");
}

function bindEvents() {
  els.btns.refresh.addEventListener("click", reloadDataDir);
  els.btns.start.addEventListener("click", loadSelectedPlaylist);
  els.btns.openDir.addEventListener("click", openDataDir);
  els.btns.changeDir.addEventListener("click", changeDataDir);

  els.btns.exit.addEventListener("click", () => guarded("home"));
  els.btns.toggle.addEventListener("click", togglePlay);
  els.btns.reveal.addEventListener("click", () => reveal(RevealType.CORRECT));
  els.btns.answer.addEventListener("click", () => reveal(RevealType.ANSWER));
  els.btns.reset.addEventListener("click", () => guarded("reset"));
  els.btns.prev.addEventListener("click", () => guarded("prev"));
  els.btns.next.addEventListener("click", () => guarded("next"));

  els.displays.round.addEventListener("click", (e) => {
    e.stopPropagation();
    els.displays.menu.classList.toggle("visible");
  });
  document.addEventListener("click", () =>
    els.displays.menu.classList.remove("visible")
  );

  window.addEventListener("keydown", (e) => {
    if (isScreenVisible("start")) handleStartKey(e);
    else if (isScreenVisible("game")) handleGameKey(e);
  });

  els.audio.addEventListener("play", () => {
    state.isPlaying = true;
    if (state.roundState === RoundState.IDLE) {
      state.roundState = RoundState.FLOW;
    }
    startSync();
    updateUI();
  });
  els.audio.addEventListener("pause", () => {
    state.isPlaying = false;
    stopSync();
    setWarning(false);
    updateUI();
  });
  els.audio.addEventListener("ended", () => {
    state.isPlaying = false;
    state.roundState = RoundState.FINISHED;
    stopSync();
    updateUI();
  });
  els.audio.addEventListener("error", () => {
    if (!els.audio.getAttribute("src")) return;
    console.error("Audio Error", els.audio.error);
    toast(`Round ${state.currentTrackIndex + 1} 音訊載入失敗`, "error");
  });
}

function handleStartKey(e) {
  switch (e.code) {
    case "Enter":
      if (state.selectedFile) {
        e.preventDefault();
        loadSelectedPlaylist();
      }
      break;
    case "KeyR":
      e.preventDefault();
      reloadDataDir();
      break;
    case "ArrowDown":
      e.preventDefault();
      selectPlaylistByIndex(state.selectionIndex + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      selectPlaylistByIndex(state.selectionIndex - 1);
      break;
  }
}

function handleGameKey(e) {
  switch (e.code) {
    case "Space":
      e.preventDefault();
      togglePlay();
      break;
    case "Enter":
      e.preventDefault();
      reveal(RevealType.CORRECT);
      break;
    case "KeyA":
      reveal(RevealType.ANSWER);
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
      guarded("home", "H");
      break;
  }
}

// ==========================================
// 防誤觸：歌曲進行中，切歌／重來／回首頁要按兩次
// ==========================================

const guard = createGuard({
  onPrompt: (label) => toast(label, "warning", { key: "guard", duration: 2000 }),
  onCancel: () => dismiss("guard"),
});

const GUARDED_ACTIONS = {
  home: { label: "回首頁", run: () => goHome() },
  reset: { label: "重來這一首", run: () => loadSong(state.currentTrackIndex) },
  next: { label: "下一首", run: () => loadSong(state.currentTrackIndex + 1) },
  prev: { label: "上一首", run: () => loadSong(state.currentTrackIndex - 1) },
};

function guarded(name, keyLabel = "按鈕") {
  const action = GUARDED_ACTIONS[name];
  const inProgress = state.roundState !== RoundState.IDLE;
  guard.run(
    name,
    `再按一次 ${keyLabel} ${action.label}`,
    () => {
      dismiss("guard");
      action.run();
    },
    inProgress
  );
}

// ==========================================
// 播放控制
// ==========================================

function loadSong(index) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentTrackIndex = index;
  const song = state.playlist[index];

  const source = resolveSource(song, { fileExists: songFileExists });
  let songUrl = "";
  if (source?.type === "file") {
    songUrl = pathToFileURL(PathHelper.songFile(source.filename)).href;
  } else if (source?.type === "url") {
    songUrl = source.url;
  } else {
    toast(`Round ${index + 1} 沒有可播放的本地音源`, "error");
  }

  state.config = {
    startTime: song.startTime || 0,
    endTime: song.endTime || 0,
  };
  state.lyricsData = lrc.parseLRC(song.lrc).lines.map((line) => ({
    time: line.time,
    rawText: line.text,
    hasMask: lrc.hasMask(line.text),
    isAnswered: false,
    stopAt: Math.max(0, line.time - STOP_LEAD),
  }));
  state.roundState = RoundState.IDLE;
  state.currentIndex = -1;
  state.isTitleVisible = false;
  state.revealType = null;
  stopSync();
  clearRoundTimers();
  if (songUrl) els.audio.src = songUrl;
  else els.audio.removeAttribute("src");
  els.audio.currentTime = state.config.startTime;
  els.audio.load();
  buildMenu();
  updateUI();
}

// play() 若隨即被 pause()（例如一開播就碰到停點）會以 AbortError 結束，屬正常情況
function playAudio() {
  els.audio.play().catch((e) => {
    if (e.name !== "AbortError") console.error(e);
  });
}

function isRunning() {
  return (
    state.roundState === RoundState.FLOW ||
    state.roundState === RoundState.REVEALING
  );
}

function togglePlay() {
  if (
    state.roundState === RoundState.LOCKED ||
    state.roundState === RoundState.FINISHED
  )
    return;
  if (els.audio.paused) playAudio();
  else els.audio.pause();
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
    if (!next || line.stopAt < next.time) {
      next = { type: "mask", time: line.stopAt, index };
    }
  });
  const end = state.config.endTime;
  if (end > t && (!next || end < next.time)) {
    next = { type: "end", time: end };
  }
  return next;
}

function schedulePreciseStop(t) {
  if (stopTimer) return;
  const next = findNextStop(t);
  if (!next || next.time - t > PRECISE_WINDOW) return;

  const delayMs = ((next.time - t) * 1000) / (els.audio.playbackRate || 1);
  stopTimer = setTimeout(() => {
    stopTimer = null;
    if (els.audio.paused || !isRunning()) return;
    const now = els.audio.currentTime;
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
  const t = els.audio.currentTime;
  els.audio.pause();
  // 對齊到停點，揭曉後一律從同一位置接續。
  // 只修正小誤差；從遮字句之後才開始播的情況不往回跳。
  if (Math.abs(t - line.stopAt) < 0.5) els.audio.currentTime = line.stopAt;
  updateUI();
}

function finishRound() {
  els.audio.pause();
  state.roundState = RoundState.FINISHED;
  updateUI();
}

function syncTick() {
  if (state.roundState === RoundState.LOCKED || els.audio.paused) return;
  const t = els.audio.currentTime;

  // 備援：計時器沒趕上（例如從停點之後開始播）時，照輪詢結果處理
  if (state.config.endTime > 0 && t >= state.config.endTime) {
    finishRound();
    return;
  }

  // 遮字句前 5 秒警示
  const nextMask = findNextStop(t);
  setWarning(
    nextMask !== null && nextMask.type === "mask" && nextMask.time - t <= 5
  );

  // 找出目前應顯示的句子
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

// ==========================================
// 畫面更新
// ==========================================

const STATUS_VIEW = {
  [RoundState.IDLE]: { text: "🟢 READY", className: "status--ready" },
  [RoundState.FLOW]: { text: "▶ PLAYING", className: "status--playing" },
  [RoundState.LOCKED]: { text: "⏸ WAITING...", className: "status--waiting" },
  [RoundState.REVEALING]: {
    [RevealType.CORRECT]: { text: "✨ CORRECT!", className: "status--correct" },
    [RevealType.ANSWER]: { text: "📖 ANSWER", className: "status--answer" },
  },
  [RoundState.FINISHED]: {
    text: "🏁 FINISHED",
    className: "status--finished",
  },
};

function setWarning(active) {
  els.warningOverlay.classList.toggle("active", active);
  els.warningIcon.classList.toggle("active", active);
}

function updateUI() {
  const roundLabel = `ROUND ${state.currentTrackIndex + 1}`;
  const isIdle = state.roundState === RoundState.IDLE;
  const isLocked = state.roundState === RoundState.LOCKED;

  // Header
  els.displays.round.textContent = roundLabel;
  const view =
    state.roundState === RoundState.REVEALING
      ? STATUS_VIEW[RoundState.REVEALING][state.revealType]
      : STATUS_VIEW[state.roundState];
  els.displays.status.className = "header__status " + view.className;
  els.displays.status.textContent = view.text;

  els.displays.visualizer.classList.toggle(
    "active",
    state.isPlaying || isLocked
  );
  els.displays.visualizer.classList.toggle("playing", state.isPlaying);

  // 歌名面板
  els.titleText.textContent =
    state.playlist[state.currentTrackIndex]?.title || "";
  els.titlePanel.classList.toggle("visible", state.isTitleVisible && !isIdle);

  // 待機畫面 / 歌詞
  els.displays.idleMsg.classList.toggle("hidden", !isIdle);
  els.displays.lyricContainer.classList.toggle("hidden", isIdle);
  if (isIdle) els.displays.idleRound.textContent = roundLabel;
  if (state.roundState !== RoundState.FLOW) setWarning(false);

  const line = state.lyricsData[state.currentIndex];
  els.displays.lyricLine.innerHTML = line ? renderLyricLine(line) : "";

  // 控制列
  els.btns.toggle.textContent = isIdle
    ? "▶ 開始 (Space)"
    : state.isPlaying
      ? "⏸ 暫停 (Space)"
      : "⏯ 播放 (Space)";
  els.btns.toggle.classList.toggle(
    "btn--disabled",
    isLocked || state.roundState === RoundState.FINISHED
  );
  els.btns.reveal.classList.toggle("btn--disabled", !isLocked);
  els.btns.answer.classList.toggle("btn--disabled", !isLocked);
}

const MASK_STAR = '<span class="mask-symbol">★</span>';

function maskAnswer(answer) {
  return lrc
    .maskStarCounts(answer)
    .map((n) => MASK_STAR.repeat(n))
    .join(" ");
}

function renderLyricLine(line) {
  if (!line.hasMask) return line.rawText;
  return line.rawText.replace(/\*(.*?)\*/g, (match, answer) => {
    if (!line.isAnswered) {
      return `<span class="magic-word">${maskAnswer(answer)}</span>`;
    }
    const classes = ["magic-word"];
    if (line.revealType === RevealType.ANSWER) classes.push("magic-word--answer");
    if (state.roundState === RoundState.REVEALING) classes.push("is-revealing");
    return `<span class="${classes.join(" ")}">${answer}</span>`;
  });
}

function buildMenu() {
  const items = state.playlist.map((song, idx) => {
    const div = document.createElement("div");
    div.className = "menu__item";
    div.classList.toggle("active", idx === state.currentTrackIndex);
    const flagged = state.roundIssues[idx + 1]?.length > 0;
    div.textContent = `Round ${idx + 1}${flagged ? " ⚠️" : ""}`;
    if (flagged) {
      div.title = state.roundIssues[idx + 1].map((i) => i.message).join("\n");
    }
    div.addEventListener("click", () => loadSong(idx));
    return div;
  });
  els.displays.menu.replaceChildren(...items);
}

// ==========================================

function init() {
  bindEvents();
  reloadDataDir();
}

init();
