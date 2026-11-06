// 手機遙控：在區網開一個 HTTP 服務，手機掃 QR code 開啟。
// 所有路徑都要帶 token，避免同網段的人看到答案。
//   GET  /r/<token>          遙控頁
//   GET  /r/<token>/events   遊戲狀態（Server-Sent Events）
//   POST /r/<token>/command  送出指令 { cmd, ...args }
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PAGE_FILE = path.join(__dirname, "..", "src", "remote", "index.html");
const PREFERRED_PORT = 39461;

let server = null;
let token = null;
let port = 0;
const clients = new Set();
let handlers = { onCommand: () => {}, getState: () => null };

// 虛擬網卡（docker、VPN 等）排到後面，QR code 用最可能是 Wi-Fi／區網的那個
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|tun|tap|utun|zt|wg|vEthernet)/i;

function addressRank(name, ip) {
  if (VIRTUAL_IFACE.test(name)) return 9;
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 5;
}

function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) =>
      (list || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, ip: a.address }))
    )
    .sort((a, b) => addressRank(a.name, a.ip) - addressRank(b.name, b.ip))
    .map((a) => a.ip);
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload ?? { active: false })}\n\n`);
}

function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // ["r", token, ...]
  if (parts[0] !== "r" || parts[1] !== token) {
    res.writeHead(404).end();
    return;
  }
  const action = parts[2] || "";

  if (req.method === "GET" && action === "") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(fs.readFileSync(PAGE_FILE));
    return;
  }
  if (req.method === "GET" && action === "events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    clients.add(res);
    send(res, handlers.getState());
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  if (req.method === "POST" && action === "command") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        const cmd = JSON.parse(body);
        if (typeof cmd.cmd === "string") handlers.onCommand(cmd);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  res.writeHead(404).end();
}

function listen(p) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handle);
    s.once("error", reject);
    s.listen(p, "0.0.0.0", () => resolve(s));
  });
}

async function start(h) {
  handlers = { ...handlers, ...h };
  if (!server) {
    token = crypto.randomBytes(12).toString("hex");
    try {
      server = await listen(PREFERRED_PORT);
    } catch {
      server = await listen(0); // 預設 port 被佔用就隨機
    }
    port = server.address().port;
  }
  return info();
}

async function info() {
  if (!server) return { running: false };
  const urls = lanAddresses().map((ip) => `http://${ip}:${port}/r/${token}`);
  const qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 240 }) : null;
  return { running: true, port, urls, qr };
}

function stop() {
  for (const res of clients) res.end();
  clients.clear();
  server?.close();
  server = null;
  token = null;
  return { running: false };
}

function broadcast(state) {
  for (const res of clients) send(res, state);
}

module.exports = { start, stop, info, broadcast };
