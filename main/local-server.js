// 只聽 127.0.0.1 的小型 HTTP 服務。
// YouTube 內嵌需要 http(s) 來源（file:// 會被拒絕），所以由這裡提供中介頁。
const http = require("http");
const fs = require("fs");
const path = require("path");

const BRIDGE_FILE = path.join(__dirname, "..", "src", "player", "yt-bridge.html");
let server = null;
let port = 0;

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.url.split("?")[0] === "/yt-bridge.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(BRIDGE_FILE));
        return;
      }
      res.writeHead(404).end();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve(port);
    });
  });
}

function bridgeUrl() {
  return port ? `http://127.0.0.1:${port}/yt-bridge.html` : null;
}

module.exports = { start, bridgeUrl };
