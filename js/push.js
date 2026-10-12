// Telegram 推送：浏览器直接调用 Bot API（表单 POST，属于"简单请求"，不触发跨域预检）
// 配置保存在本机 localStorage，不会写进代码里
const Push = (() => {
  // 和原版 crypto_minitor 同 origin，键名必须区分，否则「本机负责推送」会同时在两个看板打开 → 重复推送
  const KEY = "mtf_push";
  const DEFAULTS = {
    token: "",
    chatId: "",
    enabled: false, // 本机负责推送：只在家里那台常开的电脑上打开，避免手机和电脑重复推送
    pageUrl: "", // 消息里附带的看板链接（部署后填写）
    events: { signal: true, weak: true, tp1: true, close: true, exit: false, level: false, health: true },
  };
  let cfg = load();
  const queue = [];
  let sending = false;

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); return { ...DEFAULTS, ...v, events: { ...DEFAULTS.events, ...(v?.events ?? {}) } }; }
    catch { return { ...DEFAULTS }; }
  }
  function save(next) { cfg = { ...cfg, ...next }; localStorage.setItem(KEY, JSON.stringify(cfg)); }
  const ready = () => cfg.enabled && cfg.token && cfg.chatId;

  async function api(method, params, token = cfg.token) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: new URLSearchParams(params) });
    const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(j.description || "Telegram 返回错误");
    return j.result;
  }

  // 页面里的提醒是 HTML，转成 Telegram 支持的格式（只保留 <b>）
  function toTelegram(html) {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(?!\/?b>)[^>]+>/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n /g, "\n")
      .trim();
  }

  async function drain() {
    if (sending) return;
    sending = true;
    while (queue.length) {
      const item = queue[0];
      try {
        await api("sendMessage", { chat_id: cfg.chatId, text: item.text, parse_mode: "HTML", disable_web_page_preview: "true" });
        queue.shift();
      } catch (e) {
        item.tries = (item.tries ?? 0) + 1;
        console.warn("Telegram 推送失败", e.message);
        if (item.tries >= 5) queue.shift();
        else await new Promise((r) => setTimeout(r, 3000 * item.tries)); // 网络抖动重试
      }
    }
    sending = false;
  }

  // event: signal / weak / tp1 / close / exit / health
  function send(event, title, bodyHtml, sym) {
    if (!ready() || !cfg.events[event]) return;
    let text = `<b>${toTelegram(title)}</b>\n${toTelegram(bodyHtml)}`;
    if (cfg.pageUrl && sym) text += `\n\n${cfg.pageUrl.replace(/#.*$/, "")}#${sym}`;
    queue.push({ text });
    drain();
  }

  // 用户先给机器人发一条消息，再调用 getUpdates 拿到 chat id
  async function detectChatId(token) {
    const ups = await api("getUpdates", {}, token);
    const last = [...ups].reverse().find((u) => u.message?.chat?.id);
    if (!last) throw new Error("没找到消息：请先在 Telegram 里给你的机器人发一句话，再点一次");
    return { id: String(last.message.chat.id), name: last.message.chat.first_name || last.message.chat.title || "" };
  }

  async function test(token, chatId) {
    await api("sendMessage", { chat_id: chatId, text: "✅ 盯盘助手推送测试成功\n以后信号会发到这里。", parse_mode: "HTML" }, token);
  }

  return { get config() { return cfg; }, save, send, detectChatId, test, ready };
})();
