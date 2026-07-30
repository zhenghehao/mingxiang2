/**
 * Agnes 视觉流水线的 headless 版。
 *
 * 原来这一步跑在浏览器里：agnes-playground.html 通过 /bridge/jobs 轮询认领任务，
 * 在页面上跑完六步再把结果交回来。那意味着出片全程必须有一个页面开着并且活着 ——
 * 页面一关、一崩、一刷新，任务就变成没人认领的孤儿（2026-07-27 就是这么挂的）。
 *
 * 读完那份 HTML 的结论是：整条流水线没有一处真的需要浏览器。六个阶段
 * （提示词 → 生图 → 评分 → 运动词 → 生视频 → 合成）全是 HTTP 调用，
 * 合成那步本来就已经在 Node 里（cors-proxy.js 的 compose）。唯一沾浏览器的是
 * imgToThumb 用 canvas 缩图，这里换成 ffmpeg —— 项目里本来就带着它。
 *
 * 对外接口和 agnes.mjs 的 generateAgnesVisuals 保持一致，可以直接顶替。
 */

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CancelledError, resolveMediaBinary } from "./media.mjs";
import { SKILL_DIRECTOR, SKILL_MOTION, SKILL_JUDGE } from "./agnes-prompts.mjs";

// 2026-07-29 实测。Agnes 有两套互不相通的入口，域名、令牌、模型名三样全不同，
// 换一套就得三样一起换 —— 只改域名会 401，只改模型名会 503。
//
//   api.agnes-ai.cn     官方直连。模型只有 agnes-2.5-flash / 2.5-pro-alpha /
//                       image-2.1-flash / video-v2.0。生图 14.8 秒。← 现在用这套
//   apihub.agnes-ai.cn  聚合网关。另一批令牌，模型是 2.0 一代，生图 90 秒，
//                       且 image-2.1 在这里会网关 520。
//
// 旧的 apihub.agnes-ai.com 已经作废（DNS 每次返回不同的无关 IP，TLS 握不上手）。
const DEFAULTS = {
  baseUrl: "https://api.agnes-ai.cn",
  textModel: "agnes-2.5-flash",
  imgModel: "agnes-image-2.1-flash",
  vidModel: "agnes-video-v2.0",
  scorerUrl: "https://token.sensenova.cn/v1",
  scorerModel: "sensenova-6.7-flash-lite",
  motionUrl: "https://token.sensenova.cn/v1",
  motionModel: "sensenova-6.7-flash-lite",
  loopMode: "loop",
  candidateCount: 6,
  reservedForVideo: 3,
  // 实测一条 5 秒循环视频从提交到 completed 约 127 秒，排队时长会浮动，
  // 200 × 3 秒 = 10 分钟的预算留足余量。轮询本身很轻，等不到才是真问题。
  videoPollMax: 200,
  videoPollIntervalMs: 3000,
  // 片头那张半透明封面。原来写死在 cors-proxy.js 旁边（ROOT/cover.png），改成
  // headless 后一度变成必须手填的配置项，结果 default-config 留空、data/config.json
  // 又不进仓库 —— 云端跑出来的片子就悄悄没了封面。现在默认指向仓库自带的这张，
  // 本地和 runner 拿到的是同一个文件。
  coverPath: "assets/cover.png"
};

// 仓库根目录：本文件在 <root>/src/ 下。相对路径的 coverPath 按它解析，
// 这样不管从哪个工作目录启动（server.mjs / run-once.mjs / CI）结果都一样。
//
// 必须走 fileURLToPath，不能用 new URL(...).pathname —— 后者是百分号编码的，
// 项目目录名带中文和空格（"冥想一键工作流 2"），拿到手会是 %E5%86%A5... 找不着文件。
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 2026-07-30：只把 mist / fog / haze 从负面词里拿掉，clouds 保留。
// 被当成"雾"的多半是浅景深虚化和镜头光晕，那正是真实感照片好看的地方；
// 云则是大量实测下来出错率过高，继续压制。烟和文房用具照旧禁止。
//
// 另外记一笔：实测 agnes-image-2.1-flash **基本不理会 negative_prompt** ——
// 同一提示词给与不给负面词，出图几乎一模一样。真正管用的是正面提示词。
// 这行留着是为了以后换模型时它可能重新生效，但别指望它挡住什么。
const IMAGE_NEGATIVE = "clouds,cloud,sky only,smoke,incense,smoky,ink,inkstone,"
  + "calligraphy,ink brush,scroll,rice paper,bright,overexposed,high contrast";
const VIDEO_NEGATIVE = "camera movement,camera pan,camera zoom,camera shake,static image,frozen,"
  + "no motion,text,watermark,distorted";
const MOTION_FALLBACK = "Camera completely static and locked, gentle slow in-place natural motion "
  + "of water/mist/light, seamless loop, calm breathing rhythm.";

export function agnesHeadlessEnabled(config) {
  return Boolean(config?.agnesHeadless?.enabled);
}

/** 单独导出便于测试：key 分池的规则是这套改动里最容易出错的一处。 */
export function resolveKeyPools(apiKeys, videoKeys, reservedForVideo) {
  // 必须去重。限流是按 key 算的，不是按槽位算的 —— 同一个 key 填两遍不会变成
  // 两份配额，只会让池子看起来更大，正好把分池的意义抵消掉：
  // 以为留了 3 个给视频，实际可能是同一个 key 出现了 3 次。
  const clean = (list) => [...new Set(
    (Array.isArray(list) ? list : []).map((k) => String(k || "").trim()).filter(Boolean)
  )];
  const main = clean(apiKeys);
  const reserved = Math.max(0, Number(reservedForVideo) || 0);
  // key 太少时分池反而有害（生图并发被压到 1 甚至 0），所以给生图留至少 2 个才分。
  const partitioned = reserved > 0 && main.length - reserved >= 2;
  const explicitVideo = clean(videoKeys);
  const spare = partitioned ? main.slice(main.length - reserved) : [];
  return {
    partitioned,
    imageKeys: partitioned ? main.slice(0, main.length - reserved) : main,
    videoKeys: explicitVideo.length ? explicitVideo : (partitioned ? spare : main),
    // 待命池：首轮不参与生图，只在某张图失败后顶上。
    //
    // 之前生图失败是在**已经用过的那几把**里轮换（keyIndex+1、+2）——
    // 如果失败原因是限流，换一把同样刚被用过的没有任何意义。
    // 留几把从头到尾没碰过的，重试才真的有机会成功。
    spareKeys: spare
  };
}

function settings(config = {}) {
  const raw = config.agnesHeadless || {};
  const merged = { ...DEFAULTS, ...raw };
  const clean = (list) => [...new Set(
    (Array.isArray(list) ? list : []).map((k) => String(k || "").trim()).filter(Boolean)
  )];
  const apiKeys = clean(merged.apiKeys);
  if (!apiKeys.length) throw new Error("Agnes headless 没有配置 apiKeys");

  // ── key 分池 ────────────────────────────────────────────────────────────
  // 生图和生视频原来共用同一个池。生图会把 6 张请求平摊到所有 key 上，
  // 紧接着的生视频撞上「每分钟 2 次」的硬限流时，换 key 重试也没用 ——
  // 每个 key 都刚被生图用过。所以从池子尾部切出一段只给视频，生图永远不碰。
  //
  // key 太少时分池反而有害（生图并发被压到 1），所以只在池子够大时才分。
  const pools = resolveKeyPools(apiKeys, merged.videoKeys, merged.reservedForVideo);
  const { imageKeys, videoKeys, spareKeys, partitioned: canPartition } = pools;

  return {
    ...merged,
    apiKeys,
    imageKeys,
    videoKeys,
    spareKeys,
    partitioned: canPartition,
    baseUrl: String(merged.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, ""),
    scorerUrl: String(merged.scorerUrl || "").replace(/\/$/, ""),
    motionUrl: String(merged.motionUrl || "").replace(/\/$/, ""),
    scorerKeys: clean(merged.scorerKeys),
    motionKeys: clean(merged.motionKeys),
    coverPath: resolveCoverPath(merged.coverPath),
    candidateCount: Math.max(1, Math.min(12, Number(merged.candidateCount) || DEFAULTS.candidateCount))
  };
}

/**
 * 片头封面图的路径解析。
 *
 * 留空 = 用仓库自带的那张（不是"不要封面"）。想彻底不要封面，写 "off"。
 * 之所以把空串解释成"用默认"，是因为空串这个值最容易是**漏填**而不是真想关掉，
 * 而漏填的代价是成片悄悄少了片头 —— 云端就这么丢过一次。
 */
export function resolveCoverPath(raw) {
  const value = String(raw ?? "").trim();
  if (/^(off|none|false|no)$/i.test(value)) return "";
  if (!value) return path.join(REPO_ROOT, DEFAULTS.coverPath);
  return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new CancelledError());
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  function onAbort() { clearTimeout(timer); reject(new CancelledError()); }
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** 轮转取 key，语义同原实现的 getKey(i)。 */
const pick = (keys, index) => keys[((index % keys.length) + keys.length) % keys.length];

/**
 * 带退避的 fetch。503/429/500 才重试。
 * 429 是「每分钟 N 次」这类硬限流，秒级指数退避等不过窗口，
 * 所以按 Retry-After，没有就固定等 65 秒跨过下一个整分钟。
 */
async function fetchRetry(url, options, { retries = 4, baseDelay = 3000, signal, onNote } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new CancelledError();
    let response;
    try {
      response = await fetch(url, { ...options, signal });
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw new CancelledError();
      if (attempt === retries) throw error;
      await sleep(Math.round(baseDelay * 1.6 ** attempt), signal);
      continue;
    }
    if (![429, 500, 503].includes(response.status)) return response;
    if (attempt === retries) return response;
    let wait;
    if (response.status === 429) {
      const retryAfter = Number.parseFloat(response.headers?.get?.("retry-after"));
      wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.round(retryAfter * 1000) + 2000 : 65_000;
    } else {
      wait = Math.round(baseDelay * 1.6 ** attempt);
    }
    onNote?.(`服务繁忙（${response.status}），${Math.round(wait / 1000)} 秒后重试`);
    await sleep(wait, signal);
  }
  throw new Error("重试次数用尽");
}

/** 从模型回复里抠出 JSON。围栏、前后废话、截断都可能有。导出供测试。 */
export function extractJSON(text) {
  if (text == null) throw new Error("空回复");
  const cleaned = String(text).replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.search(/[[{]/);
  if (start < 0) throw new Error("回复里没有 JSON");
  const open = cleaned[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error("JSON 不完整（可能被截断）");
}

/** 推理模型有时把答案放在 reasoning 里，content 为空。 */
function llmContent(payload) {
  const message = payload?.choices?.[0]?.message || {};
  return message.content && message.content.trim() ? message.content : (message.reasoning || "");
}

function runFfmpeg(bin, args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let cancelled = false;
    const onAbort = () => { cancelled = true; child.kill("SIGTERM"); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(cancelled ? new CancelledError() : error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (cancelled) return reject(new CancelledError());
      if (code === 0) return resolve();
      reject(new Error(stderr.slice(-400) || `ffmpeg 退出码 ${code}`));
    });
  });
}

async function download(url, dest, signal, { expectMedia = false } = {}) {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url.slice(-60)}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  if (!expectMedia) return;
  // Content-Type 不可信：这家的 /content 端点会用 video/mp4 的头返回
  // 22 字节的 {"detail":"Not Found"}。不验文件头的话，一段 JSON 会被
  // 当成视频存下来，然后在 ffmpeg 那步才炸，报错还完全指不到真正的原因。
  const { size } = await stat(dest);
  if (size < 1024) {
    const peek = await readFile(dest, "utf8").catch(() => "");
    throw new Error(`下载到的不是媒体文件（只有 ${size} 字节）：${peek.slice(0, 120)}`);
  }
}

/**
 * 远程图 → 缩略图 data URI。
 *
 * 浏览器版用 canvas + createImageBitmap；这里用 ffmpeg 缩放转 jpg。
 * 评委一次要看 N 张图，不缩小会把上下文撑爆（原实现为此写了三级降采样兜底）。
 */
async function imgToThumb(config, url, maxSide, quality, { signal, workDir } = {}) {
  const ffmpeg = resolveMediaBinary(config.media?.ffmpegPath, "ffmpeg");
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const raw = path.join(workDir, `thumb_in_${stamp}`);
  const out = path.join(workDir, `thumb_out_${stamp}.jpg`);
  try {
    await download(url, raw, signal);
    // -q:v 2..8，数字越小越清晰。把 0.7~0.9 的 quality 映射过去。
    const q = Math.max(2, Math.min(8, Math.round((1 - quality) * 20 + 2)));
    await runFfmpeg(ffmpeg, [
      "-y", "-i", raw,
      "-vf", `scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`,
      "-q:v", String(q), out
    ], signal);
    const buffer = await readFile(out);
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } finally {
    await rm(raw, { force: true }).catch(() => {});
    await rm(out, { force: true }).catch(() => {});
  }
}

// ── 六个阶段 ──────────────────────────────────────────────────────────────

/**
 * 文稿 → N 个场景提示词。
 *
 * 模型偶尔会吐出结构损坏的 JSON（要它一次写 N 段长英文 prompt，越长越容易崩）。
 * 所以重试不只是换 key，还**降温度**：0.8 出的花样多，但正是花样多才崩；
 * 重试用 0.3 换稳定。同一个 prompt 重来一次通常就好了。
 *
 * 解析失败必须把原文带出来。以前只报一句「Expected ':' at position 2561」，
 * 而那个位置指的是模型输出、不是任何一个文件，光看报错完全无从下手。
 */
async function generatePrompts(agnes, article, count, { signal, note }) {
  const tries = Math.max(3, Math.min(4, agnes.apiKeys.length));
  let lastError = "";
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetchRetry(`${agnes.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pick(agnes.apiKeys, attempt)}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agnes.textModel,
          messages: [
            { role: "system", content: SKILL_DIRECTOR(count, agnes.loopMode) },
            { role: "user", content: `文章内容：\n${article}` }
          ],
          max_tokens: 16384,
          temperature: attempt === 0 ? 0.8 : 0.3
        })
      }, { retries: 2, signal, onNote: note });
      if (!response.ok) { lastError = `${response.status}: ${(await response.text()).slice(0, 160)}`; continue; }
      const raw = llmContent(await response.json());
      let list;
      try {
        list = extractJSON(raw);
      } catch (parseError) {
        // 把出错位置附近的原文摘出来，否则这类偶发问题永远只能靠猜
        const at = Number(/position (\d+)/.exec(parseError.message)?.[1]);
        const excerpt = Number.isFinite(at)
          ? `…${raw.slice(Math.max(0, at - 90), at + 90)}…`
          : raw.slice(0, 180);
        lastError = `${parseError.message}；模型原文片段：${excerpt}`;
        note?.(`场景提示词 JSON 解析失败，换更低温度重试（第 ${attempt + 1} 次）`);
        continue;
      }
      if (!Array.isArray(list) || !list.length) { lastError = "返回的不是场景数组"; continue; }
      return list.slice(0, count);
    } catch (error) {
      if (error?.cancelled) throw error;
      lastError = error.message;
    }
  }
  throw new Error(`提取场景失败（试了 ${tries} 次）：${lastError}`);
}

async function genSingleImage(agnes, prompt, keyIndex, { signal, note }) {
  // 先用分给自己的那把，失败后依次换待命池里的 —— 那几把首轮没人碰过，
  // 限流窗口是干净的。待命池为空时退回原来的行为（在主池里轮换）。
  const candidates = [
    pick(agnes.imageKeys, keyIndex),
    ...agnes.spareKeys,
    ...(agnes.spareKeys.length ? [] : [pick(agnes.imageKeys, keyIndex + 1), pick(agnes.imageKeys, keyIndex + 2)])
  ].filter(Boolean);
  const tries = candidates.length;
  let lastError = "";
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetchRetry(`${agnes.baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${candidates[attempt]}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: agnes.imgModel,
          prompt,
          size: "1K",
          ratio: "9:16",
          n: 1,
          negative_prompt: IMAGE_NEGATIVE
        })
      }, { retries: 2, signal, onNote: note });
      if (!response.ok) { lastError = `${response.status}: ${(await response.text()).slice(0, 160)}`; continue; }
      const payload = await response.json();
      if (payload.error) { lastError = payload.error.message || String(payload.error); continue; }
      const url = payload.data?.[0]?.url || payload.url || "";
      if (!url) { lastError = "未返回图片 URL"; continue; }
      return url;
    } catch (error) {
      if (error?.cancelled) throw error;
      lastError = error.message;
    }
  }
  throw new Error(lastError || "生图失败");
}

/**
 * 评委：把全部候选图打包进同一个请求，选出最佳。
 * 三级降采样 + 换 key 的兜底照搬原实现 —— 这一步是整条链上最容易被撑爆的。
 */
async function scoreImages(config, agnes, urls, articleText, { signal, note, workDir }) {
  if (!agnes.scorerUrl || !agnes.scorerKeys.length) throw new Error("未配置评委 AI");
  const sizes = [[512, 0.85], [384, 0.78], [256, 0.7]];
  let lastError = "";
  for (let ki = 0; ki < agnes.scorerKeys.length; ki += 1) {
    const key = agnes.scorerKeys[ki];
    try {
      for (const [maxSide, quality] of sizes) {
        const thumbs = await Promise.all(
          urls.map((u) => imgToThumb(config, u, maxSide, quality, { signal, workDir }))
        );
        const content = [{
          type: "text",
          text: `原文文章（判断画面是否符合文章描述的季节/天气/场景时参考）：\n${(articleText || "").slice(0, 1500)}\n\n`
            + `共 ${urls.length} 张候选，请务必先逐张放大检查画质(有无雪花噪点/花屏/畸变纹路/发糊)，再打分并选最佳。`
        }];
        for (const b64 of thumbs) content.push({ type: "image_url", image_url: { url: b64 } });
        const response = await fetchRetry(`${agnes.scorerUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: agnes.scorerModel,
            messages: [{ role: "system", content: SKILL_JUDGE(urls.length) }, { role: "user", content }],
            max_tokens: 16000,
            temperature: 0.3,
            reasoning_effort: "none"
          })
        }, { retries: 2, signal, onNote: note });
        if (response.status === 413) { lastError = "413 请求过大，缩小图片重试"; continue; }
        if (!response.ok) { lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`; break; }
        const payload = await response.json();
        const finish = payload.choices?.[0]?.finish_reason;
        let parsed;
        try {
          parsed = extractJSON(llmContent(payload));
        } catch (parseError) {
          if (finish === "length") { lastError = "输出被截断，缩小图片重试"; continue; }
          lastError = `解析失败：${parseError.message}`;
          break;
        }
        let best = Number.isInteger(parsed.best) ? parsed.best : 0;
        if (best < 0 || best >= urls.length) best = 0;
        return { scores: parsed.scores || [], best, bestReason: parsed.best_reason || "" };
      }
    } catch (error) {
      if (error?.cancelled) throw error;
      lastError = error.message;
    }
  }
  throw new Error(`评委全部 ${agnes.scorerKeys.length} 个 key 都失败：${lastError}`);
}

async function writeMotionPrompt(config, agnes, imageUrl, { signal, note, workDir }) {
  if (!agnes.motionUrl || !agnes.motionKeys.length) throw new Error("未配置运动导演 AI");
  const sizes = [[896, 0.9], [640, 0.82]];
  let lastError = "";
  for (let ki = 0; ki < agnes.motionKeys.length; ki += 1) {
    const key = agnes.motionKeys[ki];
    for (const [maxSide, quality] of sizes) {
      const b64 = await imgToThumb(config, imageUrl, maxSide, quality, { signal, workDir });
      const response = await fetchRetry(`${agnes.motionUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: agnes.motionModel,
          messages: [
            { role: "system", content: SKILL_MOTION() },
            {
              role: "user",
              content: [
                { type: "text", text: "这是选定的画面，请根据画面里真实存在的元素写循环运动提示词。" },
                { type: "image_url", image_url: { url: b64 } }
              ]
            }
          ],
          max_tokens: 8000,
          temperature: 0.5,
          reasoning_effort: "none"
        })
      }, { retries: 2, signal, onNote: note });
      if (response.status === 413) { lastError = "413"; continue; }
      if (!response.ok) { lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}`; break; }
      const payload = await response.json();
      const finish = payload.choices?.[0]?.finish_reason;
      // 只认真正的 content。reasoning 是大段思考原文，绝不能当运动提示词用。
      const raw = payload?.choices?.[0]?.message?.content;
      if (!raw || !raw.trim()) {
        lastError = finish === "length" ? "输出被截断" : "返回内容为空";
        continue;
      }
      const text = raw.replace(/```/g, "").trim();
      // 只按思考措辞判定，不按长度 —— 正常运动词本来就常有六七百字。
      if (/thinking process|let me analyze|self-correction|step \d[:.]|analyze the (request|image)/i.test(text)
        || text.length > 1800) {
        lastError = "疑似混入思考过程，已丢弃";
        continue;
      }
      return text;
    }
  }
  throw new Error(`运动导演全部 ${agnes.motionKeys.length} 个 key 都失败：${lastError}`);
}

/**
 * 轮询视频任务。
 *
 * 必须用 **video_id** 打 /agnesapi —— 拿 task_id 去打会 404。
 * 另一条 /v1/videos/{task_id} 文档里叫 legacy，能看状态但**不返回 metadata.url**，
 * 所以取不到成品地址，只能用来把 task_id 换成 video_id。
 *
 * 轮询失败不再静默跳过。以前这里 catch 完就 continue，结果一次配置错误
 * （地址搬错了）表现成连续 90 次静默 404，最后只报一句「轮询超时」——
 * 和「视频还在生成」看起来一模一样，白等六分钟才发现敲错了门。
 */
async function pollVideo(agnes, videoId, keyIndex, { signal, onTick }) {
  let consecutiveErrors = 0;
  let lastError = "";
  for (let i = 0; i < agnes.videoPollMax; i += 1) {
    await sleep(agnes.videoPollIntervalMs, signal);
    try {
      const response = await fetch(`${agnes.baseUrl}/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
        headers: { Authorization: `Bearer ${pick(agnes.videoKeys, keyIndex)}` },
        signal
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}：${(await response.text()).slice(0, 120)}`;
        consecutiveErrors += 1;
        // 连错 5 次就不是抖动了，是这个地址根本不对，早点说出来
        if (consecutiveErrors >= 5) throw new Error(`视频状态查询连续失败 ${consecutiveErrors} 次：${lastError}`);
        onTick?.(`状态查询失败（${response.status}），重试中`);
        continue;
      }
      consecutiveErrors = 0;
      const payload = await response.json();
      if (payload.status === "completed") {
        const url = payload.metadata?.url || payload.url || "";
        if (!url) throw new Error("视频已完成但响应里没有 metadata.url，取不到成品地址");
        return url;
      }
      if (payload.status === "failed") throw new Error(`视频生成失败：${payload.error?.message || "未知"}`);
      const label = { queued: "排队中", in_progress: "生成中" }[payload.status] || payload.status;
      onTick?.(`${label} ${payload.progress || 0}%`);
    } catch (error) {
      if (error?.cancelled || error?.name === "AbortError") throw error;
      if (/视频生成失败|连续失败|没有 metadata\.url/.test(String(error.message))) throw error;
      lastError = error.message;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw new Error(`视频状态查询连续失败 ${consecutiveErrors} 次：${lastError}`);
    }
  }
  const waited = Math.round(agnes.videoPollMax * agnes.videoPollIntervalMs / 1000);
  throw new Error(`视频生成轮询超时（等了 ${waited} 秒）${lastError ? `，最后一次错误：${lastError}` : "，期间状态一直不是 completed"}`);
}

async function genVideo(agnes, imageUrl, videoPrompt, { signal, note, onTick }) {
  const body = agnes.loopMode !== "free"
    ? {
      model: agnes.vidModel, prompt: videoPrompt, width: 720, height: 1280,
      num_frames: 121, frame_rate: 24, negative_prompt: VIDEO_NEGATIVE,
      extra_body: { mode: "keyframes", image: [imageUrl, imageUrl] }
    }
    : {
      model: agnes.vidModel, prompt: videoPrompt, image: imageUrl, width: 720, height: 1280,
      num_frames: 121, frame_rate: 24, negative_prompt: VIDEO_NEGATIVE, extra_body: {}
    };
  const tries = Math.min(3, agnes.videoKeys.length);
  let lastError = "";
  let videoId = "";
  let usedKey = 0;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetchRetry(`${agnes.baseUrl}/v1/videos`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pick(agnes.videoKeys, attempt)}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }, { retries: 2, signal, onNote: note });
      if (!response.ok) { lastError = `${response.status}: ${(await response.text()).slice(0, 160)}`; continue; }
      const payload = await response.json();
      // 提交返回的是 task_id（字段名就叫 id），而轮询要的是 video_id，两者不通用。
      // 响应里没带 video_id 时，用 legacy 的 /v1/videos/{task_id} 换一次。
      videoId = payload.video_id || "";
      const taskId = payload.id || payload.task_id || "";
      if (!videoId && taskId) {
        const lookup = await fetch(`${agnes.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: `Bearer ${pick(agnes.videoKeys, attempt)}` },
          signal
        });
        if (lookup.ok) videoId = (await lookup.json()).video_id || "";
      }
      if (!videoId) { lastError = `未能取得 video_id（task_id=${taskId || "空"}）`; continue; }
      // 轮询必须用真正提交成功的那个 key，不能还用最初分配的
      usedKey = attempt;
      break;
    } catch (error) {
      if (error?.cancelled) throw error;
      lastError = error.message;
    }
  }
  if (!videoId) throw new Error(`生视频提交失败：${lastError}`);
  return pollVideo(agnes, videoId, usedKey, { signal, onTick });
}

/**
 * 合成两段成品：纯循环去音版 + 封面淡出去音版。
 * 逻辑照搬 agnes-playground/cors-proxy.js 的 compose()。
 */
async function compose(config, agnes, videoUrl, outputDir, { signal, workDir, onNote }) {
  const ffmpeg = resolveMediaBinary(config.media?.ffmpegPath, "ffmpeg");
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpIn = path.join(workDir, `med_in_${id}.mp4`);
  const outPlain = path.join(outputDir, `${id}_plain.mp4`);
  const outCover = path.join(outputDir, `${id}_cover.mp4`);
  await download(videoUrl, tmpIn, signal, { expectMedia: true });

  // 1) 纯循环视频，去音（视频流直接 copy，无损最快）
  await runFfmpeg(ffmpeg, ["-y", "-i", tmpIn, "-an", "-c:v", "copy", "-movflags", "+faststart", outPlain], signal);

  // 2) 固定封面淡出 + 去音。scale2ref 让封面自动缩放到视频尺寸（不写死分辨率）。
  //    封面前 1 秒完整显示，第 1→3 秒淡出，之后纯视频。
  const coverPath = agnes.coverPath || "";
  let hasCover = false;
  if (coverPath) {
    hasCover = await stat(coverPath).then(() => true).catch(() => false);
    // 配了路径却找不到文件，只能是配错或文件没跟着走。以前这里悄悄退回纯净版，
    // 成片少了片头也没人知道（云端就这么丢了一整轮）。现在必须吵出来。
    if (!hasCover) onNote?.(`⚠ 片头封面图不存在，本次成片没有封面：${coverPath}`);
  } else {
    onNote?.("片头封面已按配置关闭（coverPath=off），成片不带封面");
  }
  if (hasCover) {
    await runFfmpeg(ffmpeg, [
      "-y", "-i", tmpIn, "-loop", "1", "-i", coverPath,
      "-filter_complex",
      "[1:v][0:v]scale2ref=w=iw:h=ih[cov][base];"
      + "[cov]format=yuva420p,fade=t=out:st=1:d=2:alpha=1[covf];"
      + "[base][covf]overlay=0:0:shortest=1[v]",
      "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", outCover
    ], signal);
  }
  await rm(tmpIn, { force: true }).catch(() => {});
  return { plainPath: outPlain, coverPath: hasCover ? outCover : outPlain, hasCover };
}

/**
 * 跑完整条视觉流水线。
 *
 * 返回结构与 agnes.mjs 的 generateAgnesVisuals 一致：
 * { jobId, coverPath, loopPath, selectedTitle, selectedReason }
 */
export async function generateAgnesVisualsHeadless(config, { article, title = "", onProgress, signal } = {}) {
  const agnes = settings(config);
  const ensureLive = () => { if (signal?.aborted) throw new CancelledError(); };
  const jobId = `agnes-local-${Date.now()}`;
  const note = (message) => onProgress?.({ jobId, phase: "waiting", progress: 0, message });
  const report = (phase, progress, message) => onProgress?.({ jobId, phase, progress, message });

  const outputDir = agnes.outputDir
    ? path.resolve(agnes.outputDir)
    : path.resolve(config.agnes?.projectRoot || os.tmpdir(), "output");
  const workDir = path.join(os.tmpdir(), `agnes-headless-${jobId}`);
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(workDir, { recursive: true })]);

  try {
    // 1) 提示词
    ensureLive();
    report("prompts", 5, "正在从冥想文稿提炼视觉场景");
    const prompts = await generatePrompts(agnes, article, agnes.candidateCount, { signal, note });
    const items = prompts.slice(0, agnes.candidateCount).map((p, i) => ({
      scene: i + 1,
      title: p.title || `场景${i + 1}`,
      imagePrompt: p.image_prompt
    }));

    // 2) 候选图并行。单张失败只是少一个候选，不影响整体 —— 全挂才算失败。
    ensureLive();
    report("images", 20, `正在并行生成 ${items.length} 张候选图`);
    await Promise.all(items.map((item, i) => genSingleImage(agnes, item.imagePrompt, i, { signal, note })
      .then((url) => { item.imageUrl = url; })
      .catch((error) => {
        if (error?.cancelled) throw error;
        item.imageError = error.message;
      })));
    const withImage = items.filter((item) => item.imageUrl);
    if (!withImage.length) throw new Error("候选图全部生成失败");
    report("images", 45, `候选图完成 ${withImage.length}/${items.length}`);

    // 3) 评分。挂了就退回第一张，不让它带走整条流程。
    ensureLive();
    let best = withImage[0];
    let bestReason = "";
    if (agnes.scorerUrl && agnes.scorerKeys.length && withImage.length > 1) {
      report("scoring", 55, "正在评分并选择最佳画面");
      try {
        const result = await scoreImages(
          config, agnes, withImage.map((item) => item.imageUrl), article, { signal, note, workDir }
        );
        best = withImage[result.best] || withImage[0];
        bestReason = result.bestReason;
      } catch (error) {
        if (error?.cancelled) throw error;
        report("scoring", 55, `评分失败，改用第一张候选：${error.message}`);
      }
    }

    // 4) 运动词。同样非致命，有兜底词。
    ensureLive();
    let videoPrompt = MOTION_FALLBACK;
    if (agnes.motionUrl && agnes.motionKeys.length) {
      report("motion", 62, "正在编写循环运动提示词");
      try {
        videoPrompt = await writeMotionPrompt(config, agnes, best.imageUrl, { signal, note, workDir });
      } catch (error) {
        if (error?.cancelled) throw error;
        report("motion", 62, `运动词生成失败，改用通用运动词：${error.message}`);
      }
    }

    // 5) 生视频。这一步失败就是整条失败 —— 没有它就没有成品。
    ensureLive();
    report("video", 70, "正在生成循环视频");
    const videoUrl = await genVideo(agnes, best.imageUrl, videoPrompt, {
      signal,
      note,
      onTick: (text) => report("video", 78, `正在生成循环视频 · ${text}`)
    });

    // 6) 合成
    ensureLive();
    report("done", 92, "正在整理两段视觉成品");
    const composed = await compose(config, agnes, videoUrl, outputDir, { signal, workDir, onNote: note });
    report("done", 100, composed.hasCover ? "视觉成品已完成（片头带封面）" : "视觉成品已完成（无片头封面）");

    return {
      jobId,
      coverPath: composed.coverPath,
      loopPath: composed.plainPath,
      selectedTitle: best.title || "",
      selectedReason: bestReason
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
