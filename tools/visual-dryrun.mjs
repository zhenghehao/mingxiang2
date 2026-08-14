/**
 * 视觉流水线空跑：文稿 → N 段场景提示词 →（可选）N 张图 →（可选）N 条循环视频。
 * 不评分、不合成。
 *
 * 为什么要有这个：判断「出图全是叶子和水」到底是提示词的问题还是模型的问题，
 * 以前只能整条流水线跑一遍。其实答案就在提示词里 —— 导演如果压根没写船、
 * 没写巷子，后面画什么都不可能出现船和巷子。加 --images / --videos 逐级往下走，
 * 每一级都能单独看结果，不必等到最后合成完才发现方向错了。
 *
 * 每一步都直接调 src/agnes-headless.mjs 里的生产函数，不在这里另写一套：
 * 空跑要验证的正是生产代码的行为，重写一遍等于什么都没验（而且会漏掉
 * 生产代码里的 429 退避、降温重试、三级降采样这些兜底）。
 *
 * 端点和模型一律从 data/default-config.json + data/config.json 读，不在这里
 * 写死、也不"猜一个域名试试" —— 拿真 key 去探未经确认的域名等于把凭据送人。
 *
 * 用法（key 只在这条命令的进程里存在，不落盘、不进仓库）：
 *   SENSENOVA_DIRECTOR_KEYS=... node tools/visual-dryrun.mjs [文稿.txt] [张数]
 *   SENSENOVA_DIRECTOR_KEYS=... AGNES_API_KEYS=k1,k2,... node tools/visual-dryrun.mjs --images
 *   SENSENOVA_DIRECTOR_KEYS=... AGNES_API_KEYS=k1,k2,... node tools/visual-dryrun.mjs --videos
 *
 * 不给文稿路径就用内置的样例（渡船 + 青砖巷，故意挑人造场景——这正是
 * 2026-08-14 之前那份题材白名单会全部枪毙、只能被"转译"成树叶流水的那类文稿）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMAGE_NEGATIVE, generatePrompts, genVideo, resolveAgnesSettings, writeMotionPrompt
} from "../src/agnes-headless.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SAMPLE = `夜里的渡船

你站在渡口。天已经黑透了，只有船头挂着一盏灯，光落在水面上，被水纹一下一下揉碎。
风从水面上过来，带着一点凉。你听见缆绳擦过木桩的声音，很轻，像谁在打呵欠。
船身随着水轻轻起伏，你也跟着起伏。
远处是那条青砖巷，雨刚停，石板还湿着，映着一点橘色的窗光。
你不用去哪里。这条船今晚不开。你只是坐在这里，让水替你晃。`;

const argv = process.argv.slice(2);
// --videos 蕴含 --images：没有图就没有图生视频
const wantVideos = argv.includes("--videos");
const wantImages = wantVideos || argv.includes("--images");
const positional = argv.filter((a) => !a.startsWith("--"));

const keys = (value) => String(value || "").split(/[,\s]+/).filter(Boolean);
const directorKeys = keys(process.env.SENSENOVA_DIRECTOR_KEYS || process.env.SENSENOVA_SCORER_KEYS);
const agnesKeys = keys(process.env.AGNES_API_KEYS);
// 运动导演单独一池：它是 N 张图并行各写各的，最吃 key。给几把就并行几路
// （见 writeMotionPrompt 的 keyIndex）。不单独给就退回借用导演那把。
const motionKeys = keys(process.env.SENSENOVA_MOTION_KEYS).length
  ? keys(process.env.SENSENOVA_MOTION_KEYS)
  : directorKeys;
if (!directorKeys.length) {
  console.error("没有 SenseNova 的 key。用法：SENSENOVA_DIRECTOR_KEYS=你的key node tools/visual-dryrun.mjs [文稿.txt] [张数]");
  process.exit(1);
}
if (wantImages && !agnesKeys.length) {
  console.error("要生图/生视频就得给 AGNES_API_KEYS（逗号分隔）。都不给就只出提示词。");
  process.exit(1);
}

// ── 配置：仓库默认 + 本机覆盖，再把 key 从环境变量塞进去 ──────────────────
//
// reservedForVideo 压成 0，好让 videoKeys = 全部 key。默认的 3 是为
// 「6 张图 + 1 条视频」设计的；要并行出 N 条时 3 把 key 撑不住「每分钟 2 次」
// 的限流。配合 genVideo 的 keyIndex，N 条视频落在 N 把不同的 key 上。
const dflt = JSON.parse(await readFile(path.join(ROOT, "data/default-config.json"), "utf8"));
const local = await readFile(path.join(ROOT, "data/config.json"), "utf8").then(JSON.parse).catch(() => ({}));
const config = {
  ...dflt, ...local,
  media: { ...dflt.media, ...(local.media || {}) },
  agnesHeadless: {
    ...dflt.agnesHeadless, ...(local.agnesHeadless || {}),
    apiKeys: agnesKeys.length ? agnesKeys : ["占位·本次不生图"],
    videoKeys: [],
    reservedForVideo: 0,
    directorKeys,
    motionKeys,
    scorerKeys: directorKeys
  }
};
const agnes = resolveAgnesSettings(config);
const count = Number(positional[1]) || agnes.candidateCount;
const file = positional[0];
const article = file ? await readFile(file, "utf8") : SAMPLE;

console.log(`导演   ${agnes.directorUrl || agnes.baseUrl} · ${agnes.directorModel || agnes.textModel}`);
if (wantImages) console.log(`生图   ${agnes.baseUrl} · ${agnes.imgModel} · ${agnesKeys.length} 把 key`);
if (wantVideos) console.log(`运动词 ${agnes.motionUrl} · ${agnes.motionModel} · ${agnes.motionKeys.length} 把 key（每张图各用一把）\n生视频 ${agnes.baseUrl} · ${agnes.vidModel} · loopMode=${agnes.loopMode}`);
console.log(`文稿   ${file || "（内置样例·渡船）"} ${article.length} 字 · ${count} 个场景\n`);

// ── 第一步：文稿 → N 段提示词 ─────────────────────────────────────────────
const t0 = Date.now();
let list;
try {
  list = await generatePrompts(agnes, article, count, { note: (m) => console.log(`   ${m}`) });
} catch (error) {
  console.error(`导演失败：${error.message}`);
  process.exit(1);
}
console.log(`导演耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

for (const [i, item] of list.entries()) {
  console.log(`── ${i + 1}. ${item.title}`);
  console.log(`${item.image_prompt}\n`);
}

// 这就是要看的那个数：题材白名单还在的时候，第一行必然是「N / N」。
// 放开之后，如果文稿里有具体场景，第一行应该是 0、第二行接近 N。
const NATURE_ONLY = /\b(leaf|leaves|foliage|stream|brook|creek|water\s?droplet|dewdrop|moss|bamboo)\b/i;
const BUILT = /\b(boat|lantern|window|eaves|roof|porch|bridge|stone\s?step|alley|pier|dock|door|wall|lamp|curtain|cobble|railing)\b/i;
console.log("── 统计");
console.log(`只有自然景物（叶/水/苔/竹，无任何人造物）：${list.filter((s) => NATURE_ONLY.test(s.image_prompt) && !BUILT.test(s.image_prompt)).length} / ${list.length}`);
console.log(`出现了文稿里的人造场景（船/灯/窗/檐/巷/桥…）：${list.filter((s) => BUILT.test(s.image_prompt)).length} / ${list.length}`);

if (!wantImages) {
  console.log("\n（只跑了提示词。要真的出图，加 --images 并给 AGNES_API_KEYS）");
  process.exit(0);
}

// ── 第二步：N 段提示词 → N 张图 ──────────────────────────────────────────
// 一张一把 key。单张失败只是少一个候选，不打断其它张。
const outDir = path.join(ROOT, "work/dryrun", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
await mkdir(outDir, { recursive: true });
console.log(`\n── 开始生图，落地目录 ${outDir}`);

const t1 = Date.now();
const images = await Promise.all(list.map(async (item, i) => {
  const started = Date.now();
  try {
    const res = await fetch(`${agnes.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agnes.imageKeys[i % agnes.imageKeys.length]}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: agnes.imgModel, prompt: item.image_prompt,
        size: "1K", ratio: "9:16", n: 1, negative_prompt: IMAGE_NEGATIVE
      })
    });
    if (!res.ok) return { i, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}` };
    const body = await res.json();
    if (body.error) return { i, error: body.error.message || String(body.error) };
    const url = body.data?.[0]?.url || body.url || "";
    if (!url) return { i, error: "未返回图片 URL" };
    const bin = await fetch(url);
    if (!bin.ok) return { i, error: `下载失败 HTTP ${bin.status}` };
    const dest = path.join(outDir, `${String(i + 1).padStart(2, "0")}_${item.title}.png`);
    await writeFile(dest, Buffer.from(await bin.arrayBuffer()));
    // url 要留着：图生视频拿的是**远程地址**，本地文件路径喂不进去
    return { i, dest, url, seconds: ((Date.now() - started) / 1000).toFixed(1) };
  } catch (error) {
    return { i, error: error.message };
  }
}));

console.log(`\n── 生图完成，总耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
for (const r of [...images].sort((a, b) => a.i - b.i)) {
  console.log(r.error
    ? `  ${r.i + 1}. ${list[r.i].title}  ✗ ${r.error}`
    : `  ${r.i + 1}. ${list[r.i].title}  ✓ ${r.seconds}s  ${path.basename(r.dest)}`);
}
const done = images.filter((r) => r.dest);
console.log(`\n出图成功 ${done.length}/${list.length}，目录：${outDir}`);
await writeFile(path.join(outDir, "prompts.json"), JSON.stringify(list, null, 2), "utf8");

if (!wantVideos) {
  console.log("（只到出图为止。要连视频一起跑，把 --images 换成 --videos）");
  process.exit(0);
}

// ── 第三步：N 张图 → N 条运动词 → N 条循环视频 ──────────────────────────
const workDir = path.join(outDir, ".work");
await mkdir(workDir, { recursive: true });
console.log(`\n── 开始出视频：${done.length} 条并行，视频 key 池 ${agnes.videoKeys.length} 把，每条各用一把\n`);

const t2 = Date.now();
const videos = await Promise.all(done.map(async (img, n) => {
  const tag = `${img.i + 1}.${list[img.i].title}`;
  const log = (text) => console.log(`   [${tag}] ${text}`);
  try {
    const motion = await writeMotionPrompt(config, agnes, img.url, { note: log, workDir, keyIndex: n });
    log(`运动词 ${motion.length} 字：${motion.slice(0, 100).replace(/\s+/g, " ")}…`);
    let lastTick = 0;
    const videoUrl = await genVideo(agnes, img.url, motion, {
      note: log,
      keyIndex: n,
      // 每 30 秒报一次就够，否则 N 条并行会把输出刷爆
      onTick: (text) => {
        if (Date.now() - lastTick < 30_000) return;
        lastTick = Date.now();
        log(text);
      }
    });
    const dest = path.join(outDir, `${String(img.i + 1).padStart(2, "0")}_${list[img.i].title}.mp4`);
    const bin = await fetch(videoUrl);
    if (!bin.ok) throw new Error(`视频下载失败 HTTP ${bin.status}`);
    await writeFile(dest, Buffer.from(await bin.arrayBuffer()));
    log(`✓ 完成，用时 ${((Date.now() - t2) / 1000).toFixed(0)}s`);
    return { i: img.i, dest, motion };
  } catch (error) {
    log(`✗ ${error.message}`);
    return { i: img.i, error: error.message };
  }
}));

console.log(`\n── 出视频完成，总耗时 ${((Date.now() - t2) / 1000).toFixed(1)}s`);
for (const v of [...videos].sort((a, b) => a.i - b.i)) {
  console.log(v.error
    ? `  ${v.i + 1}. ${list[v.i].title}  ✗ ${v.error}`
    : `  ${v.i + 1}. ${list[v.i].title}  ✓ ${path.basename(v.dest)}`);
}
console.log(`\n视频成功 ${videos.filter((v) => v.dest).length}/${done.length}，目录：${outDir}`);
await writeFile(path.join(outDir, "motion-prompts.json"),
  JSON.stringify(videos.map((v) => ({ title: list[v.i].title, motion: v.motion, error: v.error })), null, 2), "utf8");
