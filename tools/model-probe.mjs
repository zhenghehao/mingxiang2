/**
 * 探一批模型 ID 在 Agnes 网关上通不通。
 *
 * 为什么要有这个：配置注释里记着「image-2.1-flash 会网关 520、image-2.5-flash 和
 * video-v2.5 都是 503 model_not_found（账号下没开通道）」，据此把出图出视频锁死在
 * 2.0 一代。但 2026-08-22 用户给出正确 ID 是 **agnes-video-2.5（不带 v）** ——
 * 当初那个 503 很可能只是 ID 写错，不是通道没开。这个脚本就是来分辨这两者的。
 *
 * 只提交、不等生成完：认不认这个模型在提交那一刻就知道了，等它跑完既慢又费额度。
 * 视频提交成功会拿到一个 task id，那条任务会自己跑完并占用队列，属于必要代价。
 *
 * 用法（key 只在这条命令的进程里存在）：
 *   AGNES_API_KEYS=k1,k2 node tools/model-probe.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, readJson } from "../src/json-store.mjs";
import { applyEnvOverrides } from "../src/env-config.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = await readJson(path.join(ROOT, "data/default-config.json"), {});
const user = await readJson(path.join(ROOT, "data/config.json"), {});
const { config } = applyEnvOverrides(deepMerge(base, user));
const agnes = config.agnesHeadless;
const keys = [...new Set([
  ...(process.env.AGNES_API_KEYS || "").split(/[,、，;；\s]+/).map((s) => s.trim()).filter(Boolean),
  ...(agnes.apiKeys || [])
])];
if (!keys.length) { console.error("没有 AGNES_API_KEYS"); process.exit(1); }

console.log(`端点 ${agnes.baseUrl} · key ${keys.length} 把\n`);

// 现役的那两个也一起探，当对照组 —— 只有「新的通、旧的也通」才说明是模型问题
// 而不是网关整体在抽风。
const 图片模型 = ["agnes-image-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.5-flash"];
const 视频模型 = ["agnes-video-v2.0", "agnes-video-2.5", "agnes-video-v2.5"];

async function 探(label, url, body, i) {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${keys[i % keys.length]}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000)
    });
    const p = await r.json().catch(() => ({}));
    const 秒 = ((Date.now() - started) / 1000).toFixed(0);
    if (r.ok) {
      const 线索 = p?.data?.[0]?.url ? "拿到图片 URL" : (p?.id ? `task id ${String(p.id).slice(0, 12)}…` : JSON.stringify(p).slice(0, 60));
      console.log(`  ✅ ${label.padEnd(24)} HTTP 200  ${秒}s   ${线索}`);
      return true;
    }
    const msg = p?.error?.message || p?.message || JSON.stringify(p);
    console.log(`  ❌ ${label.padEnd(24)} HTTP ${r.status}  ${秒}s   ${String(msg).slice(0, 110)}`);
    return false;
  } catch (e) {
    console.log(`  ❌ ${label.padEnd(24)} ${e.message.slice(0, 110)}`);
    return false;
  }
}

console.log("── 生图（size=1K，最省的一档）──");
let i = 0;
const 图结果 = {};
for (const m of 图片模型) {
  图结果[m] = await 探(m, `${agnes.baseUrl}/v1/images/generations`,
    { model: m, prompt: "a quiet bamboo forest at dusk, realistic photo", size: "1K", ratio: "16:9", n: 1 }, i += 1);
}

console.log("\n── 生视频（只提交，不等出片）──");
const 视结果 = {};
for (const m of 视频模型) {
  视结果[m] = await 探(m, `${agnes.baseUrl}/v1/videos`, {
    model: m, prompt: "gentle drifting clouds, slow motion",
    width: 1080, height: 1920, num_frames: 121, frame_rate: 24, extra_body: {}
  }, i += 1);
}

console.log("\n════ 结论 ════");
const 通 = (o) => Object.entries(o).filter(([, v]) => v).map(([k]) => k);
console.log(`  生图可用：${通(图结果).join(" / ") || "（一个都不通）"}`);
console.log(`  生视频可用：${通(视结果).join(" / ") || "（一个都不通）"}`);
