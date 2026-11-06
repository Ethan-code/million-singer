// 遊戲音效：全部用 Web Audio 即時合成，不用音檔（沒有授權問題）。
// 與歌曲共用同一個 AudioContext；muted 時全部不出聲。

function createSfx(getContext) {
  let muted = false;
  let master = null;
  let roll = null; // 鼓聲滾奏（停住時循環）

  function ctx() {
    const c = getContext();
    if (!master || master.context !== c) {
      master = c.createGain();
      master.gain.value = 0.5;
      master.connect(c.destination);
    }
    if (c.state === "suspended") c.resume();
    return c;
  }

  function tone({ freq, type = "sine", start = 0, dur = 0.2, vol = 0.4, slideTo = null, attack = 0.005 }) {
    if (muted) return;
    const c = ctx();
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function noise({ start = 0, dur = 0.1, vol = 0.3, filter = 1200, type = "bandpass" }) {
    if (muted) return;
    const c = ctx();
    const t = c.currentTime + start;
    const len = Math.ceil(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = filter;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
  }

  return {
    get muted() {
      return muted;
    },
    setMuted(v) {
      muted = v;
      if (muted) this.stopRoll();
    },

    // 倒數嗶聲；最後一聲較高
    tick(final = false) {
      tone({ freq: final ? 1320 : 880, type: "square", dur: 0.12, vol: 0.18 });
    },

    // 停住：重擊＋鼓聲滾奏（直到 stopRoll）
    lock() {
      tone({ freq: 110, type: "sawtooth", dur: 0.5, vol: 0.35, slideTo: 55 });
      noise({ dur: 0.35, vol: 0.4, filter: 200, type: "lowpass" });
      this.startRoll();
    },
    startRoll() {
      this.stopRoll();
      if (muted) return;
      let n = 0;
      roll = setInterval(() => {
        n++;
        noise({ dur: 0.06, vol: 0.08 + Math.min(0.12, n * 0.002), filter: 900 });
      }, 70);
    },
    stopRoll() {
      clearInterval(roll);
      roll = null;
    },

    // 翻牌的「喀」
    flip(i = 0) {
      noise({ start: i * 0.12, dur: 0.04, vol: 0.25, filter: 3000, type: "highpass" });
    },

    // 答對：上行琶音＋和弦
    correct() {
      this.stopRoll();
      [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: "triangle", start: i * 0.08, dur: 0.35, vol: 0.3 }));
      [523, 659, 784].forEach((f) => tone({ freq: f, type: "sawtooth", start: 0.36, dur: 0.9, vol: 0.12 }));
      noise({ start: 0.36, dur: 0.6, vol: 0.12, filter: 6000, type: "highpass" });
    },

    // 公布答案（答錯）：下行的失敗音
    wrong() {
      this.stopRoll();
      tone({ freq: 392, type: "square", dur: 0.25, vol: 0.18 });
      tone({ freq: 311, type: "square", start: 0.25, dur: 0.25, vol: 0.18 });
      tone({ freq: 247, type: "square", start: 0.5, dur: 0.6, vol: 0.18, slideTo: 200 });
    },

    // 提示：叮
    hint() {
      tone({ freq: 1568, type: "sine", dur: 0.5, vol: 0.25 });
      tone({ freq: 2093, type: "sine", start: 0.06, dur: 0.5, vol: 0.15 });
    },

    // Round 開場：上升的呼嘯
    whoosh() {
      noise({ dur: 0.7, vol: 0.25, filter: 800 });
      tone({ freq: 200, type: "sine", dur: 0.7, vol: 0.15, slideTo: 900, attack: 0.3 });
    },

    // 加分：金幣聲
    coin() {
      tone({ freq: 988, type: "square", dur: 0.08, vol: 0.15 });
      tone({ freq: 1319, type: "square", start: 0.08, dur: 0.3, vol: 0.15 });
    },

    // 結算：號角
    fanfare() {
      const notes = [392, 392, 392, 523, 659, 784, 659, 784];
      const times = [0, 0.15, 0.3, 0.45, 0.75, 0.9, 1.2, 1.35];
      notes.forEach((f, i) => tone({ freq: f, type: "sawtooth", start: times[i], dur: i === notes.length - 1 ? 1.2 : 0.18, vol: 0.14 }));
    },
  };
}

module.exports = { createSfx };
