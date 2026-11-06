// 播放器抽象層：遊戲引擎與編輯器只用這組介面，不管音源是本地檔、網址還是 YouTube。
//
//   load / play() / pause() / currentTime（可設定） / paused / duration
//   muted / playbackRate / destroy()
//   事件："ready" "play" "pause" "ended" "error"（detail.message）
//
// 時間一律以「歌詞時間軸」為準；YouTube 版本的偏移（offset）在這層換算。
const { pathToFileURL } = require("url");

// ---------- 本地檔與網址：HTML <audio> ----------

class AudioPlayer extends EventTarget {
  constructor(src) {
    super();
    this.kind = "audio";
    this.el = new Audio();
    this.el.preload = "auto";
    for (const type of ["play", "pause", "ended"]) {
      this.el.addEventListener(type, () => this.dispatchEvent(new Event(type)));
    }
    this.el.addEventListener("canplay", () => this.dispatchEvent(new Event("ready")), { once: true });
    this.el.addEventListener("error", () => {
      if (!this.el.getAttribute("src")) return;
      this.dispatchEvent(new CustomEvent("error", { detail: { message: "音訊載入失敗" } }));
    });
    this.el.src = src;
  }
  play() {
    return this.el.play();
  }
  pause() {
    this.el.pause();
  }
  get currentTime() {
    return this.el.currentTime;
  }
  set currentTime(t) {
    this.el.currentTime = Math.max(0, t);
  }
  get paused() {
    return this.el.paused;
  }
  get duration() {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }
  get muted() {
    return this.el.muted;
  }
  set muted(v) {
    this.el.muted = v;
  }
  get playbackRate() {
    return this.el.playbackRate;
  }
  set playbackRate(v) {
    this.el.playbackRate = v;
  }
  // 把聲音接進 Web Audio 取得頻譜（舞台燈光與律動條用）。
  // 接上後聲音改由 AudioContext 輸出，同一個元素只能接一次。
  attachAnalyser(ctx) {
    if (this.analyser) return this.analyser;
    this.sourceNode = ctx.createMediaElementSource(this.el);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    this.sourceNode.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    return this.analyser;
  }
  destroy() {
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    this.sourceNode?.disconnect();
    this.analyser?.disconnect();
  }
}

// ---------- YouTube：透過 yt-bridge.html 中介頁 ----------

const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };
const YT_ERRORS = {
  2: "YouTube 影片 ID 無效",
  5: "YouTube 播放器錯誤",
  100: "YouTube 影片不存在或已下架",
  101: "這部 YouTube 影片不允許內嵌播放",
  150: "這部 YouTube 影片不允許內嵌播放",
  153: "YouTube 播放器設定錯誤",
};

class YouTubePlayer extends EventTarget {
  // container：放影片的元素（YouTube 規定播放器必須可見、不可被遮蓋）
  constructor({ container, bridgeUrl, videoId, offset = 0, startTime = 0 }) {
    super();
    this.kind = "youtube";
    this.offset = offset;
    this.ytTime = startTime + offset; // 最後一次回報的影片時間
    this.stamp = performance.now();
    this.rate = 1;
    this.ytDuration = 0;
    this.isPlaying = false;
    this.isMuted = false;
    this.ready = false;

    this.iframe = document.createElement("iframe");
    this.iframe.className = "yt-frame";
    this.iframe.allow = "autoplay; encrypted-media";
    const url = new URL(bridgeUrl);
    url.searchParams.set("id", videoId);
    url.searchParams.set("start", String(Math.max(0, this.ytTime)));
    this.iframe.src = url.href;
    container.replaceChildren(this.iframe);

    this.onMessage = (e) => this.handleMessage(e);
    window.addEventListener("message", this.onMessage);
  }

  handleMessage(e) {
    if (e.source !== this.iframe.contentWindow || e.data?.source !== "yt-bridge") return;
    const m = e.data;
    if (m.type === "error") {
      const message = YT_ERRORS[m.code] || `YouTube 錯誤（${m.code}）`;
      this.dispatchEvent(new CustomEvent("error", { detail: { message, code: m.code } }));
      return;
    }
    // 暫停中只接受「已暫停」的回報，避免剛下 pause 時舊的時間把位置往後推
    const playing = m.state === YT_STATE.PLAYING;
    if (playing || !this.isPlaying || m.state === YT_STATE.PAUSED) {
      this.ytTime = m.time;
      this.stamp = performance.now();
    }
    this.ytDuration = m.duration || this.ytDuration;
    this.rate = m.rate || 1;

    if (m.type === "ready" && !this.ready) {
      this.ready = true;
      if (this.isMuted) this.post("mute");
      this.dispatchEvent(new Event("ready"));
    }
    if (playing && !this.isPlaying) {
      this.isPlaying = true;
      this.dispatchEvent(new Event("play"));
    } else if (!playing && this.isPlaying && m.state !== YT_STATE.BUFFERING) {
      this.isPlaying = false;
      this.dispatchEvent(new Event(m.state === YT_STATE.ENDED ? "ended" : "pause"));
    }
  }

  post(cmd, value) {
    this.iframe.contentWindow?.postMessage({ cmd, value }, "*");
  }

  play() {
    this.post("play");
    return Promise.resolve();
  }
  pause() {
    // 立即凍結時間，不等 YouTube 回報
    this.ytTime = this.currentTime + this.offset;
    this.stamp = performance.now();
    this.post("pause");
    if (this.isPlaying) {
      this.isPlaying = false;
      this.dispatchEvent(new Event("pause"));
    }
  }
  get currentTime() {
    const elapsed = this.isPlaying ? ((performance.now() - this.stamp) / 1000) * this.rate : 0;
    return this.ytTime + elapsed - this.offset;
  }
  set currentTime(t) {
    this.ytTime = Math.max(0, t + this.offset);
    this.stamp = performance.now();
    this.post("seek", this.ytTime);
  }
  get paused() {
    return !this.isPlaying;
  }
  get duration() {
    return Math.max(0, this.ytDuration - this.offset);
  }
  get muted() {
    return this.isMuted;
  }
  set muted(v) {
    this.isMuted = v;
    this.post(v ? "mute" : "unmute");
  }
  get playbackRate() {
    return this.rate;
  }
  set playbackRate(v) {
    this.rate = v;
    this.post("rate", v);
  }
  destroy() {
    window.removeEventListener("message", this.onMessage);
    this.iframe.remove();
  }
}

// source 來自 shared/song.js 的 resolveSource()
function createPlayer(source, { songsDir, videoContainer, bridgeUrl, startTime = 0 }) {
  if (source.type === "file") {
    const path = require("path");
    return new AudioPlayer(pathToFileURL(path.join(songsDir, source.filename)).href);
  }
  if (source.type === "url") return new AudioPlayer(source.url);
  if (source.type === "youtube") {
    if (!bridgeUrl) throw new Error("YouTube 中介服務未啟動");
    return new YouTubePlayer({
      container: videoContainer,
      bridgeUrl,
      videoId: source.videoId,
      offset: source.offset,
      startTime,
    });
  }
  throw new Error(`不支援的音源：${source.type}`);
}

module.exports = { AudioPlayer, YouTubePlayer, createPlayer };
