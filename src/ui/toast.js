// 畫面內提示：取代 alert，不打斷畫面。
// info 4 秒後自動消失；error 要點一下才關。
let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-stack";
  document.body.appendChild(container);
  return container;
}

// level: "info" | "warning" | "error"
// options.key：同 key 的提示只保留最新一則（例如防誤觸提示）
function toast(message, level = "info", { key, duration } = {}) {
  const stack = ensureContainer();
  if (key) stack.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();

  const el = document.createElement("div");
  el.className = `toast toast--${level}`;
  if (key) el.dataset.key = key;
  el.textContent = message;
  el.addEventListener("click", () => el.remove());
  stack.appendChild(el);

  const ms = duration ?? (level === "error" ? 0 : 4000);
  if (ms > 0) setTimeout(() => el.remove(), ms);
  return el;
}

function dismiss(key) {
  container?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
}

module.exports = { toast, dismiss };
