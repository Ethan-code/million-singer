// 舞台 3D 背景：聚光燈、金色粒子、反光地板。
// 只負責氣氛，不放任何文字；遊戲狀態透過 setMood()、burst()、setLevel() 驅動。
const THREE = require("three");

const MOODS = {
  idle: { color: 0xffcc00, beam: 0.22, speed: 0.25, particles: 0.25 },
  flow: { color: 0xffcc00, beam: 0.32, speed: 0.6, particles: 0.5 },
  warning: { color: 0xff2a2a, beam: 0.45, speed: 1.6, particles: 0.9 },
  locked: { color: 0xff2a2a, beam: 0.5, speed: 0.05, particles: 0.1 },
  correct: { color: 0xffd34d, beam: 0.6, speed: 1.2, particles: 1.4 },
  answer: { color: 0x44ccff, beam: 0.45, speed: 0.5, particles: 0.5 },
  finished: { color: 0x8888aa, beam: 0.12, speed: 0.15, particles: 0.15 },
};

// 圓形柔光貼圖，讓粒子是發光的點而不是方塊
function glowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.8)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const BEAM_COUNT = 6;
const PARTICLE_COUNT = 900;
const BURST_COUNT = 260;

function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.045);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.set(0, 2.2, 9);

  // 地板格線：往遠方延伸的舞台感
  const grid = new THREE.GridHelper(60, 60, 0xffcc00, 0x332a00);
  grid.position.y = -2.5;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  // 地板中央的光圈，跟著音樂脈動
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.6, 3.0, 96),
    new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.4, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -2.48;
  scene.add(ring);

  // 聚光燈光束：開口圓錐，頂端亮、往下漸淡
  const beamMaterial = () =>
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color(0xffcc00) }, uOpacity: { value: 0.15 } },
      vertexShader: `
        varying float vY;
        void main() {
          vY = position.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vY;
        void main() {
          float fade = smoothstep(-12.0, 0.0, vY); // 圓錐頂端 y=0 最亮，往下（y=-12）漸淡
          gl_FragColor = vec4(uColor, uOpacity * fade * fade);
        }`,
    });
  const beams = [];
  for (let i = 0; i < BEAM_COUNT; i++) {
    const geo = new THREE.ConeGeometry(1.3, 12, 32, 1, true);
    geo.translate(0, -6, 0); // 旋轉中心在頂端
    const mesh = new THREE.Mesh(geo, beamMaterial());
    const x = (i - (BEAM_COUNT - 1) / 2) * 3.2;
    mesh.position.set(x, 7, -4 - (i % 2) * 2);
    mesh.userData.phase = i * 1.3;
    mesh.userData.dir = i % 2 ? 1 : -1;
    scene.add(mesh);
    beams.push(mesh);
  }

  // 漂浮的金色粒子
  const pGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(PARTICLE_COUNT * 3);
  const speed = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 30;
    pos[i * 3 + 1] = Math.random() * 12 - 3;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 20 - 3;
    speed[i] = 0.3 + Math.random();
  }
  pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const glow = glowTexture();
  const particles = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({ color: 0xffcc00, size: 0.16, map: glow, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  scene.add(particles);

  // 答對時的爆發粒子
  const bGeo = new THREE.BufferGeometry();
  const bPos = new Float32Array(BURST_COUNT * 3);
  const bVel = new Float32Array(BURST_COUNT * 3);
  bGeo.setAttribute("position", new THREE.BufferAttribute(bPos, 3));
  const burstPoints = new THREE.Points(
    bGeo,
    new THREE.PointsMaterial({ color: 0xffdd55, size: 0.35, map: glow, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  scene.add(burstPoints);
  let burstLife = 0;

  // ---------- 狀態 ----------
  const target = { ...MOODS.idle, color: new THREE.Color(MOODS.idle.color) };
  const now = { ...MOODS.idle, color: new THREE.Color(MOODS.idle.color) };
  let level = 0; // 音樂能量 0..1
  let smoothLevel = 0;
  let t = 0;
  let running = true;
  let last = performance.now();

  function setMood(name) {
    const m = MOODS[name] || MOODS.idle;
    target.beam = m.beam;
    target.speed = m.speed;
    target.particles = m.particles;
    target.color.setHex(m.color);
  }

  function burst(color = 0xffdd55) {
    burstPoints.material.color.setHex(color);
    for (let i = 0; i < BURST_COUNT; i++) {
      bPos[i * 3] = 0;
      bPos[i * 3 + 1] = 0.5;
      bPos[i * 3 + 2] = 2;
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * Math.PI - Math.PI / 2;
      const v = 4 + Math.random() * 6;
      bVel[i * 3] = Math.cos(a) * Math.cos(e) * v;
      bVel[i * 3 + 1] = Math.sin(e) * v + 3;
      bVel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * v * 0.5;
    }
    bGeo.attributes.position.needsUpdate = true;
    burstLife = 1;
  }

  function setLevel(v) {
    level = Math.max(0, Math.min(1, v));
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  resize();

  function frame() {
    if (!running) return;
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;
    const k = 1 - Math.pow(0.02, dt); // 平滑過渡
    now.beam += (target.beam - now.beam) * k;
    now.speed += (target.speed - now.speed) * k;
    now.particles += (target.particles - now.particles) * k;
    now.color.lerp(target.color, k);
    smoothLevel += (level - smoothLevel) * Math.min(1, dt * 12);
    t += dt * now.speed;

    beams.forEach((b, i) => {
      b.rotation.z = Math.sin(t * 1.2 + b.userData.phase) * 0.45 * b.userData.dir;
      b.rotation.x = Math.cos(t * 0.8 + b.userData.phase) * 0.25;
      b.material.uniforms.uColor.value.copy(now.color);
      b.material.uniforms.uOpacity.value = now.beam * (0.7 + smoothLevel * 0.9) * (0.8 + 0.2 * Math.sin(t * 3 + i));
    });

    ring.material.color.copy(now.color);
    ring.material.opacity = 0.2 + smoothLevel * 0.6;
    ring.scale.setScalar(1 + smoothLevel * 0.25);
    grid.material.color.copy(now.color);

    const p = pGeo.attributes.position.array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      p[i * 3 + 1] += dt * speed[i] * (0.3 + now.particles + smoothLevel);
      p[i * 3] += Math.sin(t + i) * dt * 0.1;
      if (p[i * 3 + 1] > 9) p[i * 3 + 1] = -3;
    }
    pGeo.attributes.position.needsUpdate = true;
    particles.material.color.copy(now.color);

    if (burstLife > 0) {
      burstLife = Math.max(0, burstLife - dt * 0.6);
      for (let i = 0; i < BURST_COUNT; i++) {
        bVel[i * 3 + 1] -= dt * 6; // 重力
        bPos[i * 3] += bVel[i * 3] * dt;
        bPos[i * 3 + 1] += bVel[i * 3 + 1] * dt;
        bPos[i * 3 + 2] += bVel[i * 3 + 2] * dt;
      }
      bGeo.attributes.position.needsUpdate = true;
      burstPoints.material.opacity = burstLife;
    }

    camera.position.x = Math.sin(t * 0.15) * 1.2;
    camera.position.y = 2.2 + Math.sin(t * 0.1) * 0.3;
    camera.lookAt(0, 0.5, -4);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setMood,
    burst,
    setLevel,
    stop() {
      running = false;
      renderer.dispose();
    },
  };
}

module.exports = { createScene };
