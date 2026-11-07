// 计算 Worker：策略重算不占主线程（图表拖动、面板刷新不再被 10~20ms 的重算卡住）
import { ComputeCore } from "./compute.js";
const core = new ComputeCore();
const realNow = Date.now.bind(Date);
let offset = 0;
// 和主线程用同一个"现在"：Strategy 用 Date.now 判断最后一根是否收盘
Date.now = () => realNow() + offset;
self.onmessage = (e) => {
  const msg = e.data;
  if (msg.nowMs != null) offset = msg.nowMs - realNow();
  let reply;
  try { reply = core.handle(msg); }
  catch (err) { reply = { id: msg.id, sym: msg.sym, error: String(err?.stack || err) }; }
  self.postMessage(reply);
};
