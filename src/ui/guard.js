// 防誤觸：危險操作要在時限內按第二次才生效。
// 第一次按下時呼叫 onPrompt(label) 提示使用者。
function createGuard({ windowMs = 2000, onPrompt, onCancel } = {}) {
  let pending = null; // { key, timer }

  function clear() {
    if (!pending) return;
    clearTimeout(pending.timer);
    onCancel?.(pending.key);
    pending = null;
  }

  // needConfirm 為 false 時直接執行
  function run(key, label, action, needConfirm = true) {
    if (!needConfirm) {
      clear();
      action();
      return true;
    }
    if (pending && pending.key === key) {
      clear();
      action();
      return true;
    }
    clear();
    pending = { key, timer: setTimeout(clear, windowMs) };
    onPrompt?.(label, key);
    return false;
  }

  return { run, clear };
}

module.exports = { createGuard };
