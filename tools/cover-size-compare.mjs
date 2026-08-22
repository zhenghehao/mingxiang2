/**
 * 封面尺寸档位对照：同一批提示词，分别用 1K 和 2K 出图，看哪档会出「中间分层」的接缝。
 *
 * 为什么要有这个：2026-08-22 用户反馈 16:9 封面老有一条竖向接缝，画面像左右两块拼的。
 * 已经排除了叠字那层（实测压暗渐变最大相邻跳变 1 级灰阶，且止于图宽 46%，位置对不上），
 * 也排除了拼接（一次请求出整张）。剩下的怀疑对象是出图模型本身在宽幅上的表现。
 *
 * 只能在云端跑：apihub 那批 key 只在 GitHub Secrets 里，本机没有。
 *
 * 出完图顺带做一次**接缝自动检测**：逐列算平均亮度，找相邻列的最大跳变。
 * 正常照片相邻列差几级灰阶，有缝的地方会突然跳几十级 —— 这样不用肉眼一张张看。
 *
 * 用法：
 *   AGNES_API_KEYS=k1,k2 node tools/cover-size-compare.mjs [每档每比例张数=3] [档位=1K,2K]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, readJson } from "../src/json-store.mjs";
import { applyEnvOverrides } from "../src/env-config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "work", "cover-size-test");
const COMPOSE = path.join(ROOT, "scripts", "compose_cover_text.py");

const 每档张数 = Number(process.argv[2] || 3);
const 档位 = String(process.argv[3] || "1K,2K").split(",").map((s) => s.trim()).filter(Boolean);

// 提示词固定几条，各档用同一批 —— 变量只能有「尺寸档位」一个，否则比不出东西。
const 提示词 = [
  "竹林深处的黄昏，阳光斜穿竹叶，地面铺满金色枯叶，浅景深，真实摄影",
  "雪后山谷的清晨，远处松林覆雪，前景是结霜的溪石，冷调，真实摄影",
  "夏夜荷塘，月光落在荷叶上，水面有细碎反光，静谧，真实摄影",
  "秋日老屋窗前，暖光从窗棂透入，木桌上有一只旧陶杯，真实摄影",
  "海边黄昏，退潮后的滩涂反射天光，远处有一道防波堤，真实摄影"
];

const 比例 = [
  { name: "4比3", ratio: "4:3", titleRatio: 0.108, subtitleRatio: 0.052 },
  { name: "16比9", ratio: "16:9", titleRatio: 0.136, subtitleRatio: 0.066 }
];

const base = await readJson(path.join(ROOT, "data/default-config.json"), {});
const user = await readJson(path.join(ROOT, "data/config.json"), {});
const { config } = applyEnvOverrides(deepMerge(base, user));
const agnes = config.agnesHeadless;
// AGNES_API_KEYS 会被 applyEnvOverrides 写进 agnes.apiKeys，所以这两个来源本来就重叠。
// 不去重的话日志会报「18 把」这种虚数，轮换时也会在同一把上多绕一圈。
const keys = [...new Set([
  ...(process.env.AGNES_API_KEYS || "").split(/[,、，;；\s]+/).map((s) => s.trim()).filter(Boolean),
  ...(agnes.apiKeys || [])
])];
if (!keys.length) {
  console.error("没有 AGNES_API_KEYS —— 这个脚本只能在有 key 的地方跑（云端 Secrets 或本机 config.json）");
  process.exit(1);
}

console.log(`端点 ${agnes.baseUrl}`);
console.log(`模型 ${agnes.imgModel}`);
console.log(`档位 ${档位.join(" / ")} · 每档每比例 ${每档张数} 张 · key ${keys.length} 把\n`);

const 睡 = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 出一张图。失败就换 key 重试，间隔指数退避。
 *
 * 网关会抖：实测同一批里出现过 503 ServiceUnavailable 和 180 秒超时，而相邻几张
 * 都正常。这个脚本的目的是**把每一格都填满**做对照，缺一张就少一个数据点，
 * 所以宁可慢也要重试。退避是因为撞上限流时立刻重发只会继续撞。
 */
async function 出图(prompt, size, ratio, attempt, { 重试 = 4 } = {}) {
  let 上次错 = "";
  for (let i = 0; i <= 重试; i += 1) {
    const key = keys[(attempt + i) % keys.length];
    try {
      const r = await fetch(`${agnes.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: agnes.imgModel, prompt, size, ratio, n: 1 }),
        signal: AbortSignal.timeout(240_000)
      });
      const p = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(p).slice(0, 140)}`);
      const url = p?.data?.[0]?.url;
      if (!url) throw new Error(`没拿到图片 URL：${JSON.stringify(p).slice(0, 140)}`);
      const bin = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      return Buffer.from(await bin.arrayBuffer());
    } catch (e) {
      上次错 = e.message;
      if (i === 重试) break;
      const 等 = Math.min(60, 8 * 2 ** i);
      process.stdout.write(`  ↻ 第 ${i + 1} 次失败（${e.message.slice(0, 60)}），${等}s 后换 key 重试\n`);
      await 睡(等 * 1000);
    }
  }
  throw new Error(`重试 ${重试} 次仍失败：${上次错}`);
}

/** 逐列平均亮度，返回 {宽, 高, 最大跳变, 位置, 前十大跳变} —— 用 Python 算，省得引依赖。 */
async function 查接缝(file) {
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert("L")
w, h = im.size
px = im.load()
step = max(1, h // 200)                      # 抽样 200 行足够，全算太慢
cols = [sum(px[x, y] for y in range(0, h, step)) / len(range(0, h, step)) for x in range(w)]
jumps = sorted(((abs(cols[i+1]-cols[i]), i) for i in range(w-1)), reverse=True)
print(w, h, round(jumps[0][0], 1), jumps[0][1], " ".join(f"{round(d,1)}@{i}" for d, i in jumps[:5]))
`;
  const { stdout } = await execFileAsync("python3", ["-c", py]);
  const [w, h, 跳变, 位置, ...rest] = stdout.trim().split(/\s+/);
  return { w: +w, h: +h, 跳变: +跳变, 位置: +位置, 前五: rest.join(" ") };
}

await mkdir(OUT, { recursive: true });
const 结果 = [];
let n = 0;
for (const size of 档位) {
  for (const spec of 比例) {
    for (let i = 0; i < 每档张数; i += 1) {
      const prompt = 提示词[i % 提示词.length];
      // 模型名要进文件名：同一批提示词换模型跑第二轮时，不带模型名会把第一轮覆盖掉。
      const 短模型 = agnes.imgModel.replace("agnes-image-", "").replace("-flash", "");
      const 名 = `${短模型}-${size}-${spec.name}-${i + 1}`;
      const started = Date.now();
      try {
        const buf = await 出图(prompt, size, spec.ratio, n += 1);
        const photo = path.join(OUT, `.photo-${名}.png`);
        await writeFile(photo, buf);
        const out = path.join(OUT, `${名}.png`);
        await execFileAsync("python3", [
          COMPOSE, photo, "--title", "睡前冥想", "--subtitle", `${size} · ${spec.name} · 第${i + 1}张`,
          "--output", out, "--title-ratio", String(spec.titleRatio), "--subtitle-ratio", String(spec.subtitleRatio)
        ]);
        const s = await 查接缝(photo);   // 查**原图**，避开叠字那层的干扰
        结果.push({ 名, ...s, 秒: ((Date.now() - started) / 1000).toFixed(0) });
        console.log(`✓ ${名.padEnd(16)} ${s.w}x${s.h}  最大列跳变 ${String(s.跳变).padStart(5)} @x=${s.位置}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
      } catch (e) {
        console.log(`✗ ${名.padEnd(16)} ${e.message.slice(0, 110)}`);
        结果.push({ 名, 错: e.message });
      }
    }
  }
}

console.log("\n════ 汇总（跳变越大越可能有接缝）════");
for (const size of 档位) {
  const 组 = 结果.filter((r) => r.名.includes(`-${size}-`) && !r.错);
  if (!组.length) { console.log(`${size}: 全部失败`); continue; }
  const 平均 = (组.reduce((a, b) => a + b.跳变, 0) / 组.length).toFixed(1);
  const 最大 = Math.max(...组.map((r) => r.跳变));
  console.log(`${agnes.imgModel} ${size}: ${组.length} 张 · 平均跳变 ${平均} · 最大 ${最大} · 尺寸 ${组[0].w}x${组[0].h} · 平均 ${(组.reduce((a,b)=>a+ +b.秒,0)/组.length).toFixed(0)}s`);
}
console.log(`\n图在 ${OUT}`);
