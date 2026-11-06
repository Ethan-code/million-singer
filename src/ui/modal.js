// 簡易對話框（Electron 不支援 window.prompt）
function open({ title, body, buttons }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const box = document.createElement("div");
    box.className = "modal";
    if (title) {
      const h = document.createElement("h3");
      h.className = "modal__title";
      h.textContent = title;
      box.appendChild(h);
    }
    if (body) box.appendChild(body);
    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = "btn" + (b.primary ? " btn--primary" : "") + (b.danger ? " btn--danger" : "");
      btn.textContent = b.label;
      btn.addEventListener("click", () => close(b.value()));
      actions.appendChild(btn);
    }
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const primary = buttons.find((b) => b.primary);
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      } else if (e.key === "Enter" && primary && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        e.stopPropagation();
        close(primary.value());
      }
    }
    document.addEventListener("keydown", onKey, true);
    (box.querySelector("input, textarea") || actions.lastChild)?.focus();
  });
}

function promptText(title, { value = "", placeholder = "", label } = {}) {
  const wrap = document.createElement("div");
  if (label) {
    const p = document.createElement("p");
    p.className = "modal__text";
    p.textContent = label;
    wrap.appendChild(p);
  }
  const input = document.createElement("input");
  input.className = "input";
  input.value = value;
  input.placeholder = placeholder;
  wrap.appendChild(input);
  setTimeout(() => input.select());
  return open({
    title,
    body: wrap,
    buttons: [
      { label: "取消", value: () => null },
      { label: "確定", primary: true, value: () => input.value.trim() },
    ],
  });
}

function confirmDialog(title, message, { okLabel = "確定", danger = false } = {}) {
  const p = document.createElement("p");
  p.className = "modal__text";
  p.textContent = message;
  return open({
    title,
    body: p,
    buttons: [
      { label: "取消", value: () => false },
      { label: okLabel, primary: true, danger, value: () => true },
    ],
  });
}

module.exports = { open, promptText, confirmDialog };
