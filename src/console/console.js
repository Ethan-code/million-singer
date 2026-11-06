// 控制台：題庫管理、開始遊戲、遊戲中的操作面板（看得到答案）、手機遙控設定。
const { ipcRenderer } = require("electron");
const lrc = require("../shared/lrc");
const { checkPlaylist, summarize } = require("../shared/checker");
const library = require("../shared/library");
const { toast, dismiss } = require("../ui/toast");
const { createGuard } = require("../ui/guard");
const modal = require("../ui/modal");
const { openEditor } = require("./editor");

const $ = (id) => document.getElementById(id);

const state = {
  dataDir: null,
  dataDirOk: false,
  playlists: [],
  selectedFile: null,
  songs: [],
  raw: null,
  issues: [],
  game: null, // 舞台回報的最新狀態
  view: "home",
};

const SETTINGS_KEY = "million-singer:settings";
const settings = Object.assign({ teams: "", prefer: "local" }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"));
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const fileExists = (f) => library.songFileExists(state.dataDir, f);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

function showView(name) {
  state.view = name;
  for (const v of ["home", "game", "editor"]) $(`view-${v}`).classList.toggle("hidden", v !== name);
}

// ==========================================
// 資料夾
// ==========================================

function applyDataDir(info) {
  state.dataDir = info.dir;
  state.dataDirOk = info.ok;
  $("data-dir-path").textContent = info.dir;
  $("data-dir-path").title = info.dir;
  if (!info.ok) {
    toast(
      info.error === "not-found"
        ? `找不到資料夾：${info.dir}\n請按「變更」重新選擇`
        : `無法使用資料夾：${info.error}`,
      "error"
    );
  }
}

async function reloadAll() {
  applyDataDir(await ipcRenderer.invoke("data-dir:get"));
  scanPlaylists();
}

// ==========================================
// 題庫清單
// ==========================================

function scanPlaylists() {
  state.playlists = state.dataDirOk ? safe(() => library.listPlaylists(state.dataDir), []) : [];
  if (!state.playlists.some((p) => p.file === state.selectedFile)) state.selectedFile = null;
  if (!state.selectedFile && state.playlists[0]) state.selectedFile = state.playlists[0].file;
  renderPlaylistList();
  loadSelected();
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    toast(e.message, "error");
    return fallback;
  }
}

function renderPlaylistList() {
  const items = state.playlists.map((p) =>
    el("li", {
      class: p.file === state.selectedFile ? "selected" : "",
      text: p.name,
      onclick: () => {
        state.selectedFile = p.file;
        renderPlaylistList();
        loadSelected();
      },
    })
  );
  if (items.length === 0) items.push(el("li", { class: "muted", text: "還沒有題庫" }));
  $("playlist-list").replaceChildren(...items);
}

function loadSelected() {
  const has = !!state.selectedFile;
  $("home-empty").classList.toggle("hidden", has);
  $("home-detail").classList.toggle("hidden", !has);
  if (!has) return;
  const { raw, songs, error } = library.readPlaylist(state.dataDir, state.selectedFile);
  state.raw = raw;
  state.songs = songs;
  state.issues = error
    ? [{ round: 0, level: "error", message: `題庫讀取失敗：${error}` }]
    : checkPlaylist(raw, { fileExists, prefer: settings.prefer });
  renderDetail();
}

function sourceBadges(song) {
  const badges = [];
  if (song.filename) {
    badges.push(
      fileExists(song.filename)
        ? el("span", { class: "badge badge--file", text: "本地", title: song.filename })
        : el("span", { class: "badge badge--missing", text: "缺檔", title: song.filename })
    );
  }
  if (song.youtube) badges.push(el("span", { class: "badge badge--youtube", text: "YouTube" }));
  if (song.url) badges.push(el("span", { class: "badge badge--url", text: "網址" }));
  if (badges.length === 0) badges.push(el("span", { class: "badge badge--missing", text: "無" }));
  return badges;
}

function renderDetail() {
  const name = state.selectedFile.replace(/\.json$/i, "");
  $("pl-name").textContent = name;
  const { errors, warnings } = summarize(state.issues);
  $("pl-summary").textContent =
    `${state.songs.length} 首` +
    (errors ? `・❌ ${errors} 個錯誤` : "") +
    (warnings ? `・⚠️ ${warnings} 個警告` : "") +
    (!errors && !warnings && state.songs.length ? "・✅ 檢查通過" : "");

  const top = state.issues.filter((i) => i.round === 0);
  const rows = state.songs.map((song, i) => {
    const issues = state.issues.filter((x) => x.round === i + 1);
    const masks = lrc.parseLRC(song.lrc).lines.filter((l) => lrc.hasMask(l.text)).length;
    return el(
      "tr",
      {},
      el("td", { text: String(i + 1) }),
      el("td", {}, el("div", { text: song.title || "（未命名）" }), song.artist ? el("div", { class: "artist", text: song.artist }) : null),
      el("td", {}, ...sourceBadges(song)),
      el("td", { text: String(masks) }),
      el(
        "td",
        { class: "issues" },
        ...(issues.length
          ? issues.map((x) => el("div", { class: x.level === "error" ? "is-error" : "is-warning", text: `${x.level === "error" ? "❌" : "⚠️"} ${x.message}` }))
          : [el("span", { class: "ok", text: "✓" })])
      ),
      el(
        "td",
        {},
        el(
          "div",
          { class: "row-actions" },
          el("button", { class: "btn btn--small", text: "編輯", onclick: () => editSong(i) }),
          el("button", { class: "btn btn--small", text: "↑", title: "上移", onclick: () => moveSong(i, -1) }),
          el("button", { class: "btn btn--small", text: "↓", title: "下移", onclick: () => moveSong(i, 1) }),
          el("button", { class: "btn btn--small btn--danger", text: "刪除", onclick: () => deleteSong(i) })
        )
      )
    );
  });
  if (top.length) {
    rows.unshift(el("tr", {}, el("td", { colspan: "6", class: "issues" }, ...top.map((x) => el("div", { class: "is-error", text: `❌ ${x.message}` })))));
  }
  if (state.songs.length === 0 && !top.length) {
    rows.push(el("tr", {}, el("td", { colspan: "6", class: "muted", text: "還沒有歌曲，按右上「新增歌曲」開始出題" })));
  }
  $("song-rows").replaceChildren(...rows);

  const playable = state.songs.length > 0 && !top.length;
  $("btn-start").disabled = !playable;
  $("setup-note").textContent = errors ? `有 ${errors} 個錯誤，開始前會再確認` : "";
}

function savePlaylist() {
  safe(() => library.writePlaylist(state.dataDir, state.selectedFile, state.songs));
  loadSelected();
}

function moveSong(i, delta) {
  const j = i + delta;
  if (j < 0 || j >= state.songs.length) return;
  [state.songs[i], state.songs[j]] = [state.songs[j], state.songs[i]];
  savePlaylist();
}

async function deleteSong(i) {
  const song = state.songs[i];
  const ok = await modal.confirmDialog("刪除歌曲", `確定要從題庫刪除「${song.title || "未命名"}」？\n（音檔不會被刪除）`, {
    okLabel: "刪除",
    danger: true,
  });
  if (!ok) return;
  state.songs.splice(i, 1);
  savePlaylist();
}

async function newPlaylist() {
  if (!state.dataDirOk) return;
  const name = await modal.promptText("新增題庫", { placeholder: "例如：2027 尾牙" });
  if (!name) return;
  const file = safe(() => library.createPlaylist(state.dataDir, name), null);
  if (!file) return;
  state.selectedFile = file;
  scanPlaylists();
}

// ==========================================
// 編輯器
// ==========================================

function editSong(index) {
  showView("editor");
  openEditor({
    container: $("view-editor"),
    dataDir: state.dataDir,
    playlistFile: state.selectedFile,
    songs: state.songs,
    index,
    onClose: () => {
      showView("home");
      loadSelected();
    },
  });
}

// ==========================================
// 開始遊戲
// ==========================================

async function startGame() {
  if (!state.selectedFile || state.songs.length === 0) return;
  settings.teams = $("teams").value;
  settings.prefer = $("prefer").value;
  saveSettings();
  loadSelected();

  const { errors } = summarize(state.issues);
  if (errors > 0) {
    const ok = await modal.confirmDialog(
      "題庫有錯誤",
      `這個題庫有 ${errors} 個錯誤（例如找不到音檔），有問題的 Round 可能無法播放。\n仍要開始嗎？`,
      { okLabel: "仍要開始" }
    );
    if (!ok) return;
  }
  const teams = settings.teams
    .split(/[,，、\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const result = await ipcRenderer.invoke("game:start", {
    dataDir: state.dataDir,
    playlistFile: state.selectedFile,
    playlistName: state.selectedFile.replace(/\.json$/i, ""),
    teams,
    prefer: settings.prefer,
  });
  showView("game");
  if (result?.display === "external") toast("舞台已開在第二個螢幕");
  else if (result?.display === "same") toast("只有一個螢幕：舞台在另一個視窗，按 F 全螢幕；可用手機遙控看答案");
}

// ==========================================
// 遊戲操作面板
// ==========================================

const sendCommand = (cmd) => ipcRenderer.send("game:command", cmd);

const guard = createGuard({
  onPrompt: (label) => toast(label, "warning", { key: "guard", duration: 2000 }),
  onCancel: () => dismiss("guard"),
});

const GUARDED = { reset: "重來這一首", next: "下一首", prev: "上一首", end: "結束遊戲" };

function guarded(cmd, label = "按鈕", extra = {}) {
  const g = state.game;
  const inProgress = g && g.roundState !== "IDLE";
  const key = cmd === "goto" ? `goto-${extra.index}` : cmd;
  const what = cmd === "goto" ? `跳到 Round ${extra.index + 1}` : GUARDED[cmd];
  guard.run(
    key,
    `再按一次 ${label} ${what}`,
    () => {
      dismiss("guard");
      sendCommand({ cmd, ...extra });
    },
    inProgress || cmd === "end"
  );
}

const STATUS_TEXT = {
  IDLE: "🟢 準備",
  FLOW: "▶ 播放中",
  LOCKED: "🎤 接唱中",
  REVEALING: "✨ 揭曉",
  FINISHED: "🏁 本首結束",
};

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function highlightAnswers(text) {
  return escapeHtml(text).replace(/\*(.*?)\*/g, "<mark>$1</mark>");
}

let lastRoundsKey = "";

function renderGame(g) {
  state.game = g;
  if (!g || !g.active) return;
  if (state.view !== "game") showView("game");

  $("gp-playlist").textContent = g.playlistName;
  $("gp-status").textContent =
    g.roundState === "REVEALING" && g.revealType === "answer" ? "📖 公布答案" : STATUS_TEXT[g.roundState];
  $("gp-round").textContent = `Round ${g.roundIndex + 1} / ${g.roundCount}`;
  $("gp-title").textContent = g.title + (g.artist ? ` — ${g.artist}` : "");
  const src = { file: ["本地檔案", "badge--file"], youtube: ["YouTube", "badge--youtube"], url: ["網址", "badge--url"] }[g.sourceType] || ["無音源", "badge--missing"];
  $("gp-source").textContent = src[0];
  $("gp-source").className = `badge ${src[1]}`;
  $("gp-masks").textContent = `遮字 ${g.maskAnswered} / ${g.maskCount}`;

  const end = g.endTime > 0 ? g.endTime : g.duration;
  const span = Math.max(0.001, end - g.startTime);
  $("gp-progress").style.width = `${Math.min(100, Math.max(0, ((g.time - g.startTime) / span) * 100))}%`;
  $("gp-time").textContent = `${lrc.formatTime(g.time)} / ${lrc.formatTime(end || 0)}`;

  // 答案區
  const box = $("gp-answer");
  const f = g.focusMask;
  box.classList.toggle("is-locked", g.roundState === "LOCKED");
  box.classList.toggle("is-soon", !!f && !f.isCurrent && f.inSeconds <= 5 && g.isPlaying);
  if (f) {
    $("gp-answer-label").textContent = f.isCurrent
      ? "⏸ 停住了！答案是"
      : `下一個遮字（${f.inSeconds.toFixed(1)} 秒後）`;
    $("gp-answer-text").textContent = f.answers.join("　");
    // 整句遮字時，下面那行和答案一樣，不重複顯示
    const whole = lrc.stripMasks(f.text).trim() === f.answers.join(" ").trim();
    $("gp-answer-line").innerHTML = whole ? "" : highlightAnswers(f.text);
    const team = g.turn >= 0 ? g.teams[g.turn]?.name : "";
    $("gp-answer-meta").textContent =
      (team ? `輪到 ${team}・` : "") + `${f.points} 分` + (f.hinted ? `（已提示 ${f.hinted} 字）` : "");
  } else {
    $("gp-answer-meta").textContent = "";
    $("gp-answer-label").textContent = g.maskCount ? "這首的遮字都答完了" : "這首沒有遮字";
    $("gp-answer-text").textContent = "—";
    $("gp-answer-line").innerHTML = g.currentLine ? highlightAnswers(g.currentLine.text) : "";
  }

  // 按鈕狀態
  const locked = g.roundState === "LOCKED";
  $("gp-toggle").textContent = g.roundState === "IDLE" ? "▶ 開始 (Space)" : g.isPlaying ? "⏸ 暫停 (Space)" : "⏯ 播放 (Space)";
  $("gp-toggle").disabled = locked || g.roundState === "FINISHED" || !g.sourceType;
  $("gp-correct").disabled = !locked;
  $("gp-reveal").disabled = !locked;
  $("gp-hint").disabled = !locked || !f || f.hinted >= f.units - 1;
  $("gp-replay").disabled = !locked;
  $("gp-skip").disabled = locked || g.roundState === "FINISHED" || !g.sourceType;
  $("gp-mute").textContent = g.sfxMuted ? "🔇 音效 (M)" : "🔊 音效 (M)";
  $("gp-results").textContent = g.resultsVisible ? "✖ 關閉結果 (P)" : "🏆 公布結果 (P)";
  $("gp-prev").disabled = g.roundIndex === 0;
  $("gp-next").disabled = g.roundIndex >= g.roundCount - 1;
  $("gp-scoreboard").classList.toggle("btn--primary", g.scoreboardVisible && g.teams.length > 0);
  $("gp-scoreboard").disabled = g.teams.length === 0;

  // Round 清單（內容變了才重建，避免閃爍）
  const roundsKey = JSON.stringify([g.roundIndex, g.rounds]);
  if (roundsKey !== lastRoundsKey) {
    lastRoundsKey = roundsKey;
    $("gp-round-list").replaceChildren(
      ...g.rounds.map((r, i) =>
        el(
          "li",
          {
            class: i === g.roundIndex ? "is-current" : "",
            title: r.issues.join("\n"),
            onclick: () => i !== g.roundIndex && guarded("goto", "", { index: i }),
          },
          el("span", { text: `${i + 1}.` }),
          el("span", { text: r.title || "（未命名）" }),
          r.issues.length ? el("span", { text: "⚠️" }) : null
        )
      )
    );
  }

  renderTeams(g.teams, g.turn);
}

let lastTeamsKey = "";
function renderTeams(teams, turn) {
  const key = JSON.stringify([teams, turn]);
  if (key === lastTeamsKey) return;
  lastTeamsKey = key;
  $("gp-teams").replaceChildren(
    ...teams.map((t, i) =>
      el(
        "div",
        {
          class: "team-card" + (i === turn ? " is-turn" : ""),
          title: "點一下設為輪到這隊",
          onclick: (e) => e.target.tagName !== "BUTTON" && sendCommand({ cmd: "turn", team: i }),
        },
        el("div", { class: "team-card__name", text: t.name }),
        el("div", { class: "team-card__score", text: String(t.score) }),
        el(
          "div",
          { class: "team-card__btns" },
          ...[-100, 100, 200, 500].map((d) =>
            el("button", {
              class: "btn btn--small" + (d > 0 ? "" : " btn--danger"),
              text: d > 0 ? `+${d}` : String(d),
              onclick: () => sendCommand({ cmd: "score", team: i, delta: d }),
            })
          )
        )
      )
    )
  );
}

function onGameEnded() {
  state.game = null;
  lastRoundsKey = "";
  lastTeamsKey = "";
  guard.clear();
  showView("home");
  loadSelected();
}

function handleGameKey(e) {
  if (state.view !== "game" || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  switch (e.code) {
    case "Space":
      e.preventDefault();
      sendCommand({ cmd: "toggle" });
      break;
    case "Enter":
      e.preventDefault();
      sendCommand({ cmd: "correct" });
      break;
    case "KeyA":
      sendCommand({ cmd: "answer" });
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
    case "KeyS":
      sendCommand({ cmd: "scoreboard" });
      break;
    case "KeyI":
      sendCommand({ cmd: "hint" });
      break;
    case "KeyB":
      sendCommand({ cmd: "replay" });
      break;
    case "KeyN":
      sendCommand({ cmd: "skip" });
      break;
    case "KeyP":
      sendCommand({ cmd: "results" });
      break;
    case "KeyM":
      sendCommand({ cmd: "mute" });
      break;
    case "Digit1":
    case "Digit2":
    case "Digit3":
    case "Digit4":
    case "Digit5":
    case "Digit6":
      sendCommand({ cmd: "turn", team: Number(e.code.slice(5)) - 1 });
      break;
    case "KeyF":
      ipcRenderer.send("stage:fullscreen");
      break;
  }
}

// ==========================================
// 手機遙控
// ==========================================

async function openRemote() {
  let info = await ipcRenderer.invoke("remote:info");
  const body = el("div");
  const render = () => {
    if (!info.running) {
      body.replaceChildren(
        el("p", {
          class: "modal__text",
          text: "開啟後，主持人用手機掃 QR code 就能看到答案、操作播放與計分。\n手機和這台電腦要連同一個 Wi-Fi。",
        })
      );
      return;
    }
    body.replaceChildren(
      el(
        "div",
        { class: "remote-box" },
        info.qr ? el("img", { src: info.qr, alt: "QR code" }) : null,
        el(
          "div",
          {},
          el("p", { class: "modal__text", text: "用手機掃描，或在手機瀏覽器輸入：" }),
          ...(info.urls.length ? info.urls.map((u) => el("p", {}, el("code", { text: u }))) : [el("p", { class: "muted", text: "找不到區網位址，請確認已連上網路" })]),
          el("p", {
            class: "modal__text muted",
            text: "連不上時：公司 Wi-Fi 可能隔離裝置，可改用筆電開熱點讓手機連；也要確認防火牆允許 port " + info.port + "。\n網址含密碼，不要分享給參賽者。",
          })
        )
      )
    );
  };
  render();
  const result = await modal.open({
    title: "📱 手機遙控",
    body,
    buttons: info.running
      ? [
          { label: "停止遙控", danger: true, value: () => "stop" },
          { label: "關閉", primary: true, value: () => null },
        ]
      : [
          { label: "取消", value: () => null },
          { label: "開啟手機遙控", primary: true, value: () => "start" },
        ],
  });
  if (result === "start") {
    try {
      info = await ipcRenderer.invoke("remote:start");
      updateRemoteButton(info);
      openRemote();
    } catch (e) {
      toast(`無法開啟手機遙控：${e.message}`, "error");
    }
  } else if (result === "stop") {
    updateRemoteButton(await ipcRenderer.invoke("remote:stop"));
  }
}

function updateRemoteButton(info) {
  $("btn-remote").classList.toggle("btn--primary", !!info.running);
  $("btn-remote").textContent = info.running ? "📱 手機遙控中" : "📱 手機遙控";
}

// ==========================================

function bindEvents() {
  $("btn-open-dir").addEventListener("click", () => ipcRenderer.invoke("data-dir:open"));
  $("btn-change-dir").addEventListener("click", async () => {
    const info = await ipcRenderer.invoke("data-dir:choose");
    if (!info) return;
    applyDataDir(info);
    scanPlaylists();
  });
  $("btn-rescan").addEventListener("click", reloadAll);
  $("btn-new-playlist").addEventListener("click", newPlaylist);
  $("btn-add-song").addEventListener("click", () => editSong(null));
  $("btn-start").addEventListener("click", startGame);
  $("btn-remote").addEventListener("click", openRemote);
  $("prefer").addEventListener("change", () => {
    settings.prefer = $("prefer").value;
    saveSettings();
    loadSelected();
  });
  $("teams").addEventListener("change", () => {
    settings.teams = $("teams").value;
    saveSettings();
  });

  $("gp-toggle").addEventListener("click", () => sendCommand({ cmd: "toggle" }));
  $("gp-correct").addEventListener("click", () => sendCommand({ cmd: "correct" }));
  $("gp-reveal").addEventListener("click", () => sendCommand({ cmd: "answer" }));
  $("gp-reset").addEventListener("click", () => guarded("reset"));
  $("gp-prev").addEventListener("click", () => guarded("prev"));
  $("gp-next").addEventListener("click", () => guarded("next"));
  $("gp-end").addEventListener("click", () => guarded("end"));
  $("gp-scoreboard").addEventListener("click", () => sendCommand({ cmd: "scoreboard" }));
  $("gp-hint").addEventListener("click", () => sendCommand({ cmd: "hint" }));
  $("gp-replay").addEventListener("click", () => sendCommand({ cmd: "replay" }));
  $("gp-skip").addEventListener("click", () => sendCommand({ cmd: "skip" }));
  $("gp-results").addEventListener("click", () => sendCommand({ cmd: "results" }));
  $("gp-mute").addEventListener("click", () => sendCommand({ cmd: "mute" }));
  $("gp-fullscreen").addEventListener("click", () => ipcRenderer.send("stage:fullscreen"));
  window.addEventListener("keydown", handleGameKey);

  ipcRenderer.on("game:state", (e, g) => renderGame(g));
  ipcRenderer.on("game:ended", onGameEnded);
}

async function init() {
  $("teams").value = settings.teams;
  $("prefer").value = settings.prefer;
  bindEvents();
  await reloadAll();
  updateRemoteButton(await ipcRenderer.invoke("remote:info"));
  const g = await ipcRenderer.invoke("game:get-state");
  if (g?.active) renderGame(g);
}

init();

// 給測試與除錯用
window.__console = { state, settings, sendCommand };
