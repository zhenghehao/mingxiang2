/**
 * Agnes 视觉流水线的 headless 版。
 *
 * 原来这一步跑在浏览器里：agnes-playground.html 通过 /bridge/jobs 轮询认领任务，
 * 在页面上跑完六步再把结果交回来。那意味着出片全程必须有一个页面开着并且活着 ——
 * 页面一关、一崩、一刷新，任务就变成没人认领的孤儿（2026-07-27 就是这么挂的）。
 *
 * 读完那份 HTML 的结论是：整条流水线没有一处真的需要浏览器。各个阶段
 * （提示词 → 生图 → 运动词 → 生视频 → 合成）全是 HTTP 调用，
 * （2026-08-14 起「评分」那一阶段已删除，见 generateAgnesVisualsHeadless）
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
import { CancelledError, makeSeamlessLoop, resolveMediaBinary } from "./media.mjs";
import { SKILL_DIRECTOR, SKILL_MOTION } from "./agnes-prompts.mjs";

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
  // 导演（文稿 → N 段场景提示词）这一步**不看图**，所以没必要占着 Agnes 的
  // 多模态额度和 key。留空 = 照旧走 Agnes（baseUrl + apiKeys + textModel），
  // 填了 URL 且拿得到 key 才切过去 —— 配一半不会把流水线搞挂，只会退回原路。
  // directorKeys 留空时自动借用 scorerKeys：同一家 SenseNova、同一个账号，
  // 没必要逼人再配第三份 key。
  directorUrl: "",
  directorModel: "",
  directorKeys: [],
  scorerUrl: "https://token.sensenova.cn/v1",
  scorerModel: "sensenova-6.7-flash-lite",
  motionUrl: "https://token.sensenova.cn/v1",
  motionModel: "sensenova-6.7-flash-lite",
  loopMode: "loop",
  // 循环接缝的交叉淡化秒数。0 = 关掉（直接用模型给的原片）。
  // 实测 0.4 秒最好，拉长到 0.8/1.2 秒没有改善，反而更糊。
  loopFadeSeconds: 0.4,
  candidateCount: 5,
  // 必须 >= candidateCount。视频限流是每分钟 1 次（见下面 settings 里的实测记录），
  // N 条候选并行提交，视频 key 不足 N 就有 N-reserved 条各等 65 秒。
  reservedForVideo: 5,
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
export const IMAGE_NEGATIVE = "clouds,cloud,sky only,smoke,incense,smoky,ink,inkstone,"
  + "calligraphy,ink brush,scroll,rice paper,bright,overexposed,high contrast";
const VIDEO_NEGATIVE = "camera movement,camera pan,camera zoom,camera shake,static image,frozen,"
  + "no motion,text,watermark,distorted";
const MOTION_FALLBACK = "Camera completely static and locked, gentle slow in-place natural motion "
  + "of water/mist/light, seamless loop, calm breathing rhythm.";

// settings() 也导出：tools/visual-dryrun.mjs 要用同一套 key 分池和默认值跑空跑，
// 自己再搭一套等于测的不是生产代码。改名导出是因为 "settings" 在别人的模块
// 命名空间里太泛，看不出是谁的设置。
export { settings as resolveAgnesSettings };

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
  // 生图和生视频原来共用同一个池。生图会把 N 张请求平摊到所有 key 上，
  // 紧接着的生视频撞上硬限流时，换 key 重试也没用 —— 每个 key 都刚被生图用过。
  // 所以从池子尾部切出一段只给视频，生图永远不碰。
  //
  // 2026-08-14 实测：视频限流是**每分钟 1 次**，网关原话
  // 「allows 1 requests per 1 minute(s)」。这里长期写的「每分钟 2 次」是错的，
  // 而这个数直接决定 reservedForVideo 要留多少 —— N 条候选并行提交时，
  // 视频 key 不足 N 就有 N-reserved 条各等 65 秒。
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
    directorUrl: String(merged.directorUrl || "").replace(/\/$/, ""),
    directorKeys: clean(merged.directorKeys).length ? clean(merged.directorKeys) : clean(merged.scorerKeys),
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
export function resolveDirectorEndpoint(agnes) {
  // 两个都齐了才切走。只填 URL 不给 key，或反过来，都退回 Agnes ——
  // 半套配置让整条流水线在第一步就死，比"没换成"糟得多。
  if (agnes.directorUrl && agnes.directorKeys?.length) {
    return {
      url: `${agnes.directorUrl}/chat/completions`,
      keys: agnes.directorKeys,
      model: agnes.directorModel || agnes.textModel,
      label: "独立导演端点"
    };
  }
  return {
    url: `${agnes.baseUrl}/v1/chat/completions`,
    keys: agnes.apiKeys,
    model: agnes.textModel,
    label: "Agnes 网关"
  };
}

/**
 * 判断一条失败是不是「内容审核拒了」。
 *
 * 这类失败和限流、超时不是一回事：重试同一条提示词永远还是被拒，
 * 必须**换措辞重写**才有机会过。所以要单独认出来。
 */
export function isContentPolicyFailure(message) {
  return /content_policy_violation|Unable to generate this content/i.test(String(message || ""));
}

/**
 * 补生一条场景：让导演换个完全不同的意象重写。
 *
 * 【注意：这是**兜底**，不是首选】
 * 2026-08-14 实测推翻了最初的判断。原本以为内容审核是针对特定措辞的，
 * 因为连续四轮每轮都恰好掉一条、且集中在雨夜巷子那类题材。
 * 但把其中一条被拒过的提示词**原样**再打 6 次，6 次全过。
 * 结论：这个拒绝是随机的瞬时行为，和写了什么无关。
 *
 * 所以正确的处理顺序是「先原样重试，重试还不行才换措辞」——
 * 原样重试能保住导演本来想要的那个场景，也省一次导演调用。
 * 这个函数只在原样重试也失败时才用，那时才有理由怀疑提示词本身有问题。
 */
export async function regenerateScene(agnes, article, rejected, { signal, note, keyIndex = 0 } = {}) {
  const endpoint = resolveDirectorEndpoint(agnes);
  const response = await fetchRetry(endpoint.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pick(endpoint.keys, keyIndex)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [
        { role: "system", content: SKILL_DIRECTOR(1) },
        {
          role: "user",
          content: `文章内容：\n${article}\n\n`
            + `【重要】下面这个场景被图像/视频服务的内容审核拒绝了，请**换一个完全不同的场景**重写一条。\n`
            + `不要沿用它的地点、意象和措辞，换一个方向（比如它写的是雨夜巷弄，就换成水边、林间或室内烛光这类完全不同的画面）。\n`
            + `被拒绝的标题：${rejected.title}\n`
            + `被拒绝的提示词：${rejected.imagePrompt}`
        }
      ],
      max_tokens: 4096,
      temperature: 0.9
    })
  }, { retries: 2, signal, onNote: note });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 160)}`);
  const list = extractJSON(llmContent(await response.json()));
  const one = Array.isArray(list) ? list[0] : list;
  if (!one?.image_prompt) throw new Error("补生的场景里没有 image_prompt");
  return { title: one.title || rejected.title, imagePrompt: one.image_prompt };
}

export async function generatePrompts(agnes, article, count, { signal, note } = {}) {
  const endpoint = resolveDirectorEndpoint(agnes);
  const tries = Math.max(3, Math.min(4, endpoint.keys.length));
  let lastError = "";
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetchRetry(endpoint.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${pick(endpoint.keys, attempt)}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: endpoint.model,
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
  throw new Error(`提取场景失败（${endpoint.label} / ${endpoint.model}，试了 ${tries} 次）：${lastError}`);
}

export async function genSingleImage(agnes, prompt, keyIndex, { signal, note } = {}) {
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
 * keyIndex：这一张图从 motionKeys 的第几把开始取。和 genVideo 的同名参数同一个道理。
 *
 * 原来这里恒从 0 开始（`motionKeys[ki]`，ki 是**换 key 重试**的序号）。
 * 只给一张图写运动词时没问题；一旦 N 张图并行各写各的，N 个调用会同时抓
 * motionKeys[0] —— 后面几把从头到尾闲着，而第一把被 N 倍的量砸中。
 * SenseNova 那边是按 token/分钟算的（超了报 inference tpm exhausted），
 * 所以「多给几把 key」这件事必须在这里生效，否则加再多也只用得上第一把。
 */
export async function writeMotionPrompt(config, agnes, imageUrl, { signal, note, workDir, keyIndex = 0 } = {}) {
  if (!agnes.motionUrl || !agnes.motionKeys.length) throw new Error("未配置运动导演 AI");
  const sizes = [[896, 0.9], [640, 0.82]];
  let lastError = "";
  for (let ki = 0; ki < agnes.motionKeys.length; ki += 1) {
    // 从分给自己的那把起轮转：第 n 张图先用第 n 把，失败才依次换下一把
    const key = pick(agnes.motionKeys, keyIndex + ki);
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

/**
 * keyIndex：这一条视频从 videoKeys 的第几把开始取。
 *
 * 原来这里写死从 0 开始（`pick(videoKeys, attempt)`，attempt 是**重试**次数）。
 * 单条视频时没问题；一旦要并行出 N 条，N 个调用会在第一次尝试时全部抓同一把 key，
 * 而视频那边是「每分钟 1 次」的硬限流 —— 等于自己把自己打成 429，
 * 然后每条各等 65 秒。并行出 6 条的方案就是被这一行挡住的。
 */
export async function genVideo(agnes, imageUrl, videoPrompt, { signal, note, onTick, keyIndex = 0 } = {}) {
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
          Authorization: `Bearer ${pick(agnes.videoKeys, keyIndex + attempt)}`,
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
          headers: { Authorization: `Bearer ${pick(agnes.videoKeys, keyIndex + attempt)}` },
          signal
        });
        if (lookup.ok) videoId = (await lookup.json()).video_id || "";
      }
      if (!videoId) { lastError = `未能取得 video_id（task_id=${taskId || "空"}）`; continue; }
      // 轮询必须用真正提交成功的那个 key，不能还用最初分配的
      usedKey = keyIndex + attempt;
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

  // 0) 先把首尾接缝抹平（2026-08-14 接入）。
  //
  // 生视频那边虽然用 keyframes 模式把同一张图同时喂给首帧和尾帧，但模型只是
  // 「尽量」回到原样，做不到逐像素一致。实测五条片子接缝跳变比片内正常帧间跳变
  // 差 1.4~11.0 dB，画面越安静的越明显。而这段 5 秒循环片在成品里要重复几百遍
  // ——接缝差一点，观众就要看它顿几百次。所以在这里过一道，之后所有产物都是干净的。
  //
  // 失败不致命：抹不平就用原片，顶多接缝还在，不该让整条流水线为此挂掉。
  const fade = Number(agnes.loopFadeSeconds ?? 0.4);
  let source = tmpIn;
  if (fade > 0) {
    const seamless = path.join(workDir, `med_loop_${id}.mp4`);
    try {
      const r = await makeSeamlessLoop(config, tmpIn, seamless, { fadeSeconds: fade, signal });
      source = seamless;
      onNote?.(`已抹平循环接缝：${r.sourceDuration.toFixed(2)}s → ${r.loopDuration.toFixed(2)}s（交叉 ${r.fadeSeconds}s）`);
    } catch (error) {
      if (error?.cancelled) throw error;
      onNote?.(`⚠ 循环接缝处理失败，改用原片（接缝可能可见）：${error.message}`);
    }
  }

  // 1) 纯循环视频，去音。source 已经是编码过的，直接 copy 不必再压一遍。
  await runFfmpeg(ffmpeg, ["-y", "-i", source, "-an", "-c:v", "copy", "-movflags", "+faststart", outPlain], signal);

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
      "-y", "-i", source, "-loop", "1", "-i", coverPath,
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
/**
 * 跑完整条视觉流水线。
 *
 * 2026-08-14 改：**评委已删除**。
 *
 * 原来是「N 张图 → 评委看图打分选 1 张 → 只给那张写运动词 → 只出 1 条视频」，
 * 于是另外 N-1 张图白生成、白花钱，最终画面由模型替人选。现在改成
 * 「N 张图 → 每张各写各的运动词 → 每张各出一条视频 → N 条全留下」，
 * 挑哪条由人来定（pickIndex），模型不再代劳。
 *
 * 每张图的运动词和视频都用**自己那一把 key**（keyIndex），否则 N 路并行会
 * 全挤在第 0 把上，把自己打成 429 —— 这也是这个方案以前做不成的技术障碍。
 *
 * pickIndex 决定最终成片用哪一条；不传就用第 0 条，这样调用方不改也能跑。
 * 返回值里 coverPath / loopPath 指向被选中的那条（沿用旧字段名，
 * workflow.mjs 不用动），candidates 里是全部 N 条，供界面挑选。
 */
export async function generateAgnesVisualsHeadless(config, {
  article, title = "", onProgress, signal, pickIndex
} = {}) {
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
    // 1) 文稿 → N 段场景提示词
    ensureLive();
    report("prompts", 5, "正在从冥想文稿提炼视觉场景");
    const prompts = await generatePrompts(agnes, article, agnes.candidateCount, { signal, note });
    const items = prompts.slice(0, agnes.candidateCount).map((p, i) => ({
      scene: i + 1,
      title: p.title || `场景${i + 1}`,
      imagePrompt: p.image_prompt
    }));

    // 2) N 张图并行。单张失败只是少一个候选，全挂才算失败。
    ensureLive();
    report("images", 15, `正在并行生成 ${items.length} 张画面`);
    await Promise.all(items.map((item, i) => genSingleImage(agnes, item.imagePrompt, i, { signal, note })
      .then((url) => { item.imageUrl = url; })
      .catch((error) => {
        if (error?.cancelled) throw error;
        item.imageError = error.message;
      })));
    const withImage = items.filter((item) => item.imageUrl);
    if (!withImage.length) throw new Error("候选图全部生成失败");
    report("images", 35, `画面完成 ${withImage.length}/${items.length}`);

    // 3) 每张图各写各的运动词。并行，各用一把 key。
    //    单张写失败不致命 —— 退回通用运动词，这一条照样能出视频。
    ensureLive();
    report("motion", 45, `正在为 ${withImage.length} 张画面分别编写运动提示词`);
    await Promise.all(withImage.map(async (item, n) => {
      if (!agnes.motionUrl || !agnes.motionKeys.length) { item.motion = MOTION_FALLBACK; return; }
      try {
        item.motion = await writeMotionPrompt(config, agnes, item.imageUrl, {
          signal, note, workDir, keyIndex: n
        });
      } catch (error) {
        if (error?.cancelled) throw error;
        item.motion = MOTION_FALLBACK;
        item.motionError = error.message;
      }
    }));

    // 4) 每张图各出一条循环视频。并行，各用一把 key。
    ensureLive();
    report("video", 55, `正在并行生成 ${withImage.length} 条循环视频`);
    let 完成 = 0;
    await Promise.all(withImage.map(async (item, n) => {
      try {
        const url = await genVideo(agnes, item.imageUrl, item.motion, {
          signal, note, keyIndex: n,
          onTick: (text) => report("video", 60, `第 ${item.scene} 条 · ${text}`)
        });
        item.videoUrl = url;
        完成 += 1;
        report("video", 60 + Math.round((完成 / withImage.length) * 25),
          `循环视频完成 ${完成}/${withImage.length}`);
      } catch (error) {
        if (error?.cancelled) throw error;
        item.videoError = error.message;
      }
    }));
    let withVideo = withImage.filter((item) => item.videoUrl);

    // 4b) 被内容审核拦掉的，换个说法补生一条。
    //
    // 只补**内容审核**这一类：限流、超时重试原提示词就行，而被审核拒的
    // 重试多少次都是同一个结果，必须换意象。只跑一轮 —— 补生也可能再被拒，
    // 无限补下去会把时间和额度烧光，而少一条候选并不致命。
    const 被拒 = items.filter((item) =>
      (item.imageError && isContentPolicyFailure(item.imageError))
      || (item.videoError && isContentPolicyFailure(item.videoError)));
    if (被拒.length && withVideo.length < agnes.candidateCount) {
      ensureLive();
      report("video", 84, `${被拒.length} 条被内容审核拒绝，正在重试补生`);
      const 补 = await Promise.all(被拒.map(async (bad, n) => {
        const slot = withImage.length + n;
        try {
          // 先原样重试。实测这个拒绝是随机的（同一条提示词打 6 次全过），
          // 所以多半换把 key 重来一次就成了，还能保住导演本来想要的场景。
          let item = { scene: bad.scene, title: bad.title, imagePrompt: bad.imagePrompt };
          try {
            item.imageUrl = await genSingleImage(agnes, item.imagePrompt, slot, { signal, note });
            note?.(`「${bad.title}」原样重试通过`);
          } catch (again) {
            if (again?.cancelled) throw again;
            // 原样重试还是不行，这才有理由怀疑提示词本身，换个意象重写
            note?.(`「${bad.title}」原样重试仍被拒，改为换意象重写`);
            const fresh = await regenerateScene(agnes, article, bad, { signal, note, keyIndex: n + 1 });
            item = { scene: bad.scene, title: fresh.title, imagePrompt: fresh.imagePrompt, regenerated: true };
            item.imageUrl = await genSingleImage(agnes, item.imagePrompt, slot + 1, { signal, note });
          }
          item.motion = (agnes.motionUrl && agnes.motionKeys.length)
            ? await writeMotionPrompt(config, agnes, item.imageUrl, {
              signal, note, workDir, keyIndex: slot
            }).catch(() => MOTION_FALLBACK)
            : MOTION_FALLBACK;
          item.videoUrl = await genVideo(agnes, item.imageUrl, item.motion, {
            signal, note, keyIndex: slot,
            onTick: (text) => report("video", 86, `补生「${item.title}」· ${text}`)
          });
          return item;
        } catch (error) {
          if (error?.cancelled) throw error;
          note?.(`补生「${bad.title}」仍未通过：${String(error.message).slice(0, 80)}`);
          return null;
        }
      }));
      const 成功 = 补.filter(Boolean);
      if (成功.length) {
        withVideo = [...withVideo, ...成功];
        report("video", 87, `补生成功 ${成功.length}/${被拒.length} 条`);
      }
    }

    if (!withVideo.length) throw new Error("循环视频全部生成失败");

    // 5) 每条都合成落地，人挑之前得先看得见。
    ensureLive();
    report("done", 88, `正在整理 ${withVideo.length} 条候选视频`);
    await Promise.all(withVideo.map(async (item) => {
      try {
        const composed = await compose(config, agnes, item.videoUrl, outputDir, { signal, workDir, onNote: note });
        item.loopPath = composed.plainPath;
        item.coverPath = composed.coverPath;
        item.hasCover = composed.hasCover;
      } catch (error) {
        if (error?.cancelled) throw error;
        item.composeError = error.message;
      }
    }));
    const candidates = withVideo.filter((item) => item.loopPath);
    if (!candidates.length) throw new Error("候选视频全部合成失败");

    // 6) 选一条给下游。没指定就第 0 条 —— 调用方不改也能跑通。
    const index = Number.isInteger(pickIndex) && pickIndex >= 0 && pickIndex < candidates.length
      ? pickIndex
      : 0;
    const picked = candidates[index];
    report("done", 100, `视觉候选已完成 ${candidates.length} 条，本次采用第 ${index + 1} 条`);

    return {
      jobId,
      // 沿用旧字段名，workflow.mjs 那边一行都不用改
      coverPath: picked.coverPath,
      loopPath: picked.loopPath,
      selectedTitle: picked.title || "",
      selectedReason: `${candidates.length} 条候选中的第 ${index + 1} 条`,
      pickedIndex: index,
      // 全部候选，供界面挑选
      candidates: candidates.map((item, i) => ({
        index: i,
        scene: item.scene,
        title: item.title,
        imagePrompt: item.imagePrompt,
        motion: item.motion,
        imageUrl: item.imageUrl,
        loopPath: item.loopPath,
        coverPath: item.coverPath
      })),
      failures: items
        .filter((item) => item.imageError || item.videoError || item.composeError)
        .map((item) => ({
          scene: item.scene,
          title: item.title,
          error: item.imageError || item.videoError || item.composeError
        }))
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
