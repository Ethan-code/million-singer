const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { ipcRenderer } = require("electron");

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
  // 遊戲
  playlist: [],
  currentTrackIndex: 0,
  roundState: RoundState.IDLE,
  currentIndex: -1,
  lyricsData: [],
  config: { startTime: 0, endTime: 0 },
  isTitleVisible: false,
  isPlaying: false,
};

let syncTimer = null;

const $ = (id) => document.getElementById(id);

const els = {
  screens: {
    start: $("screen-start"),
    game: $("screen-game"),
  },
  audio: $("audioPlayer"),
  status: $("load-status"),
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

  state.selectionIndex = index;
  state.selectedFile = state.availableFiles[index];
  const items = els.playlistList.children;
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle("selected", i === index);
  }
  items[index].scrollIntoView({ block: "nearest", behavior: "smooth" });
  els.btns.start.classList.remove("btn--disabled");
}

function loadSelectedPlaylist() {
  if (!state.selectedFile) return;
  const filePath = PathHelper.playlistFile(state.selectedFile);
  try {
    const pl = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(pl) || pl.length === 0) {
      throw new Error("格式錯誤：必須是包含歌曲的陣列");
    }
    state.playlist = pl;
    switchScreen("game");
    loadSong(0);
  } catch (e) {
    alert("讀取題庫失敗: " + e.message);
  }
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
  stopSync();
  els.audio.pause();
  switchScreen("start");
}

function bindEvents() {
  els.btns.refresh.addEventListener("click", reloadDataDir);
  els.btns.start.addEventListener("click", loadSelectedPlaylist);
  els.btns.openDir.addEventListener("click", openDataDir);
  els.btns.changeDir.addEventListener("click", changeDataDir);

  els.btns.exit.addEventListener("click", goHome);
  els.btns.toggle.addEventListener("click", togglePlay);
  els.btns.reveal.addEventListener("click", reveal);
  els.btns.reset.addEventListener("click", () =>
    loadSong(state.currentTrackIndex)
  );
  els.btns.prev.addEventListener("click", () =>
    loadSong(state.currentTrackIndex - 1)
  );
  els.btns.next.addEventListener("click", () =>
    loadSong(state.currentTrackIndex + 1)
  );

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
  els.audio.addEventListener("error", (e) => {
    console.error("Audio Error", e);
    alert("音訊載入失敗，請確認 songs 資料夾內是否有該檔案。");
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
      reveal();
      break;
    case "KeyR":
      loadSong(state.currentTrackIndex);
      break;
    case "ArrowRight":
      loadSong(state.currentTrackIndex + 1);
      break;
    case "ArrowLeft":
      loadSong(state.currentTrackIndex - 1);
      break;
    case "KeyH":
      goHome();
      break;
  }
}

// ==========================================
// 播放控制
// ==========================================

function loadSong(index) {
  if (index < 0 || index >= state.playlist.length) return;
  state.currentTrackIndex = index;
  const song = state.playlist[index];

  let songUrl = song.url;
  if (!songUrl && song.filename) {
    songUrl = pathToFileURL(PathHelper.songFile(song.filename)).href;
  }

  state.config = {
    startTime: song.startTime || 0,
    endTime: song.endTime || 0,
  };
  state.lyricsData = parseLRC(song.lrc);
  state.roundState = RoundState.IDLE;
  state.currentIndex = -1;
  state.isTitleVisible = false;
  stopSync();
  els.audio.src = songUrl;
  els.audio.currentTime = state.config.startTime;
  els.audio.load();
  buildMenu();
  updateUI();
}

function togglePlay() {
  if (
    state.roundState === RoundState.LOCKED ||
    state.roundState === RoundState.REVEALING ||
    state.roundState === RoundState.FINISHED
  )
    return;
  if (els.audio.paused) els.audio.play().catch(console.error);
  else els.audio.pause();
}

function startSync() {
  stopSync();
  syncTimer = setInterval(syncTick, 50);
}

function stopSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

function syncTick() {
  if (state.roundState === RoundState.LOCKED || els.audio.paused) return;
  const t = els.audio.currentTime;

  if (state.config.endTime > 0 && t >= state.config.endTime) {
    els.audio.pause();
    state.roundState = RoundState.FINISHED;
    updateUI();
    return;
  }

  // 遮字句前 5 秒警示
  const nextMask = state.lyricsData.find(
    (line) => line.time > t && line.hasMask && !line.isAnswered
  );
  setWarning(nextMask !== undefined && nextMask.time - t <= 5);

  // 找出目前應顯示的句子
  let activeIdx = -1;
  for (let i = 0; i < state.lyricsData.length; i++) {
    if (t >= state.lyricsData[i].time) activeIdx = i;
    else break;
  }
  if (activeIdx === -1 || activeIdx === state.currentIndex) return;

  state.currentIndex = activeIdx;
  const target = state.lyricsData[activeIdx];
  if (target.hasMask && !target.isAnswered) {
    state.roundState = RoundState.LOCKED;
    els.audio.pause();
  }
  updateUI();
}

function reveal() {
  if (state.roundState !== RoundState.LOCKED) return;
  state.lyricsData[state.currentIndex].isAnswered = true;
  state.roundState = RoundState.REVEALING;
  state.isTitleVisible = true;
  els.audio.play();
  updateUI();
  setTimeout(() => {
    if (state.roundState === RoundState.REVEALING) {
      state.roundState = RoundState.FLOW;
      updateUI();
    }
  }, 250);
}

// ==========================================
// 畫面更新
// ==========================================

const STATUS_VIEW = {
  [RoundState.IDLE]: { text: "🟢 READY", className: "status--ready" },
  [RoundState.FLOW]: { text: "▶ PLAYING", className: "status--playing" },
  [RoundState.LOCKED]: { text: "⏸ WAITING...", className: "status--waiting" },
  [RoundState.REVEALING]: {
    text: "✨ CORRECT!",
    className: "status--correct",
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
  const view = STATUS_VIEW[state.roundState];
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
}

const MASK_STAR = '<span class="mask-symbol">★</span>';

// 遮字顯示：英文（半形）單字一顆星，中文等依字數給星
function maskAnswer(answer) {
  return answer
    .split(" ")
    .map((part) => {
      if (!part) return "";
      if (/^[\x00-\xff]*$/.test(part)) return MASK_STAR;
      return MASK_STAR.repeat(part.length);
    })
    .join(" ");
}

function renderLyricLine(line) {
  if (!line.hasMask) return line.rawText;
  return line.rawText.replace(/\*(.*?)\*/g, (match, answer) => {
    if (!line.isAnswered) {
      return `<span class="magic-word">${maskAnswer(answer)}</span>`;
    }
    const revealing =
      state.roundState === RoundState.REVEALING ? "is-revealing" : "";
    return `<span class="magic-word ${revealing}">${answer}</span>`;
  });
}

function buildMenu() {
  const items = state.playlist.map((song, idx) => {
    const div = document.createElement("div");
    div.className = "menu__item";
    div.classList.toggle("active", idx === state.currentTrackIndex);
    div.textContent = `Round ${idx + 1}`;
    div.addEventListener("click", () => loadSong(idx));
    return div;
  });
  els.displays.menu.replaceChildren(...items);
}

// ==========================================
// LRC 解析
// ==========================================

function parseLRC(lrc) {
  if (!lrc) return [];
  const lines = Array.isArray(lrc) ? lrc : lrc.split("\n");
  return lines
    .map((line) => {
      const match = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/.exec(line);
      if (!match) return null;
      const time =
        parseInt(match[1]) * 60 +
        parseInt(match[2]) +
        parseInt(match[3].padEnd(3, "0")) / 1000;
      const rawText = line.replace(/\[.*?\]/, "").trim();
      return {
        time,
        rawText,
        hasMask: rawText.includes("*"),
        isAnswered: false,
      };
    })
    .filter((x) => x)
    .sort((a, b) => a.time - b.time);
}

// ==========================================

function init() {
  bindEvents();
  reloadDataDir();
}

init();
