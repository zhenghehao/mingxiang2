/**
 * cover.mjs — 封面图生成模块
 *
 * 流程：
 * 1. 用 deepseek-v4-flash（走 SenseNova 端点）根据冥想内容生成两条图片 prompt（4:3 和 16:9）
 * 2. 用 SenseNova U1 Fast 分别生成两张封面图
 * 3. 保存到桌面 bilibili 文件夹，命名为 "4比3.png" 和 "16比9.png"
 *
 * 封面图要求：
 * - 包含中文文字（左侧）
 * - 主标题固定为"睡前冥想"
 * - 副标题根据本次内容生成
 */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 密钥只从环境变量读，支持多把轮转。
//
// 这里原来兜底着一个明文 key，因为「本机方便」。但这个文件是要提交进 git 的 ——
// 一旦推上去，密钥就永久留在历史里，删掉也还在，只能作废重换。
//
// SENSENOVA_API_KEYS 可以用逗号或换行分隔填多把；SENSENOVA_API_KEY 是单把的旧写法，
// 两个都认。多把的意义是**一把限流或失效自动换下一把** —— 封面这一步只有 B 站要，
// 为了一张图卡住不值得，但白白失败也不值得。
function readSenseNovaKeys() {
  const raw = [process.env.SENSENOVA_API_KEYS, process.env.SENSENOVA_API_KEY]
    .filter(Boolean).join(",");
  // 分隔符全都认：半角逗号、全角逗号、顿号、分号、换行、空格。
  // 全角逗号是中文输入法的默认，切不开会把整串当成一把 key。
  return [...new Set(raw.split(/[,、，;；\s]+/).map((k) => k.trim()).filter(Boolean))];
}
/**
 * 环境变量优先；没有就用配置里那批 SenseNova key。
 *
 * 2026-08-14 加的回退。在此之前只认环境变量，于是出现过这种局面：
 * config.json 里躺着 100 把 SenseNova key（导演/评委/运动词都在用，
 * 端点和封面这里完全相同，就是 token.sensenova.cn），封面这一步却报
 * 「未配置 SENSENOVA_API_KEYS 环境变量」把整条流水线卡死。
 * 同一家、同一个端点的 key 已经在手边，没道理逼人再 export 一遍。
 */
function resolveKeys(config) {
  const fromEnv = readSenseNovaKeys();
  if (fromEnv.length) return fromEnv;
  const a = config?.agnesHeadless || {};
  return [...new Set(
    [...(a.directorKeys || []), ...(a.scorerKeys || []), ...(a.motionKeys || [])]
      .map((k) => String(k || "").trim()).filter(Boolean)
  )];
}

/** 轮转取 key。只有一把时永远返回那把，行为和以前完全一致。 */
function pickKey(keys, index = 0) {
  if (!keys.length) return "";
  return keys[((index % keys.length) + keys.length) % keys.length];
}
const CHAT_URL = "https://token.sensenova.cn/v1/chat/completions";
// B 站上传要去固定目录取封面，所以保留这个约定；换机器时用环境变量改。
const BILIBILI_DIR = process.env.MEDITATION_COVER_DIR
  || path.join(homedir(), "Desktop", "bilibili");

// 4:3 → 2368x1760, 16:9 → 2752x1536
//
// titleRatio / subtitleRatio 是文字高度占**图高**的比例，两种尺寸各有一套。
// 为什么不共用一个比例：16:9 只有 1536 高、4:3 有 1760 高，同一个比例算出来
// 前者 165px、后者 190px —— 同比例反而不同大小，看着就是 16:9 的字偏小。
// 现在 4:3 用 0.108（190px）、16:9 用 0.136（208px），照实际出图挑定的。
// size 这一栏现在只是**兜底**：真实尺寸以出图结果为准（见 readPngSize）。
// 留着是因为读不到 PNG 头时总得有个数，而且 titleRatio/subtitleRatio 是相对高度的比例，
// 换模型换尺寸都不用动。
const COVER_SPECS = [
  { name: "4比3", size: "2368x1760", aspect: "4:3", titleRatio: 0.108, subtitleRatio: 0.052 },
  { name: "16比9", size: "2752x1536", aspect: "16:9", titleRatio: 0.136, subtitleRatio: 0.066 }
];

// 文字用本地脚本叠，不再让图片模型渲染 —— 见 composeCoverText 的注释。
const COMPOSE_SCRIPT = fileURLToPath(new URL("../scripts/compose_cover_text.py", import.meta.url));

/**
 * 用 sensenova-6.7-flash-lite 生成封面图的 prompt 和副标题
 */
/**
 * 从模型回复里抠出 JSON 对象。
 *
 * 原来只剥前后的 markdown 围栏再直接 JSON.parse —— 模型在 JSON 前后多说一句话
 * （"好的，结果如下："）就整段解析失败，然后静默退回模板，副标题退化成标题原文。
 * 这里改成找第一个 { 到与之配对的 }，中间的引号和转义正常处理。
 */
function parseCoverJson(text) {
  const raw = String(text || "").replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("回复里没有 JSON 对象");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error(`JSON 不完整，可能被截断（收到 ${raw.length} 字符）`);
}

// max_tokens 从 3200 起。这段要输出副标题 + 两条完整 image_prompt，
// 每条 prompt 本身就有几百字；原来给 1500 实测会被截断，一截断就退回模板。
async function generateCoverPrompts(keys, topic, script, retries = 3, maxTokens = 3200) {
  const system = `你是一位资深冥想视觉设计师，擅长为 AI 图片模型（SenseNova U1）撰写高质量中文+英文混合 prompt。根据用户提供的冥想选题和文稿摘要，生成封面图的 prompt 和副标题。

【核心原则：具体胜过抽象】
图片模型对「具体场景 + 材质 + 光源 + 色彩」的响应远好于「意境插画」「抽象氛围图形」这类泛化描述。每条 prompt 必须包含一个看得见、摸得着的具体画面，而不是模糊的情绪词。

【prompt 结构模板——每条 prompt 必须按此顺序组织】
1. 左侧留白区：画面左侧约四成宽度必须是安静的深色暗部——大片阴影、暗色岩壁、无细节的夜色都可以，不要把主体或抢眼的亮点放在这一侧。这块地方留给后期叠文字用。
   【绝对不要在图里画任何文字】标题是后期用程序叠上去的，图片模型不需要也不允许渲染文字。每条 prompt 都要写明：画面中不出现任何文字、汉字、字母、数字、水印、logo、印章；no text, no letters, no words, no watermark, no logo, no typography, no captions, no signature。
2. 右侧主场景（最重要）：从文稿中提炼一个具体、有质感的冥想意象场景。必须包含——
   - 主体物件：看得清细节的自然物或器物（如：古朴棋盘上的黑白棋子、松枝上积雪、叶尖水珠、烛火、苔石溪流、竹叶露水）
   - 材质纹理：写出物件的材质感（如：木质纹理、石面苔藓、蜡油光泽、叶脉水渍）
   - 光源：一盏具体的微弱光源（暖琥珀烛光、清冷月光、微弱星光），写明光打在什么上面、产生什么效果
   - 场景必须与文稿内容的季节、天气、情绪一致，不能套用固定模板
3. 背景色调：深蓝与暗紫色渐变夜空，暖色微光从光源处弥散，整体偏暗、低饱和
4. 氛围词（固定尾部）：真实感摄影，浅景深，主体锐利，背景柔和虚化。vertical composition, very low light, moody and dim, soft bokeh, cinematic, film grain, dreamy, hypnotic sleep-inducing mood, no people, no text, no letters, no words, no watermark, no logo

【副标题要求】
- 6-12个中文字
- 从文稿中提炼一个有诗意、有画面的意象（如"松窗棋罢的残局微光""雪落竹枝的深夜呼吸"）
- 不要用泛化情绪词（如"安静入眠""深度放松"），要用具体画面

【禁止】
- 右侧场景不要写"抽象氛围图形""意境插画"——要写具体的东西
- 不要出现云、烟、人物（云的实测出错率过高；烟是燃烧物）
- 雾可以有：薄雾、水汽、朦胧这类词现在允许使用。硬要求是**主体本身必须清晰锐利**，雾和虚化只能在背景或环境层，不能把主体也糊掉。注意区分——雾是弥漫无形状的空气层（允许），云是天上有轮廓的成团结构（禁止）。

输出格式（严格 JSON，不要代码围栏）：
{
  "subtitle": "根据内容生成的副标题（6-12个字）",
  "prompt_4_3": "用于 4:3 比例图片的完整 prompt",
  "prompt_16_9": "用于 16:9 比例图片的完整 prompt"
}`;

  const user = `选题：${topic.slice(0, 300)}\n\n文稿摘要（前500字）：${script.slice(0, 500)}`;

  // 每次重试换下一把 key：限流和额度耗尽都是按 key 算的，在同一把上死等没意义。
  // retries 从 3 递减，所以 3-retries 就是第几次尝试。
  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pickKey(keys, 3 - retries)}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      // 这一步只读文稿、不看图，所以不需要多模态模型，挑最快且能稳定出 JSON 的。
      //
      // 2026-07-25 换掉 sensenova-6.7-flash-lite：那是个**推理模型**，先吐 reasoning
      // 再吐 content。实测 max_tokens=1000 时 reasoning 烧掉 3735 字符、content 为空；
      // 加到 4000，reasoning 涨到 10909，content 仍是 0，finish_reason 一直是 length ——
      // 推理会撑满你给的任何预算，加 token 无解。结果 JSON.parse("") 抛错，
      // 把整条流程带走（用户看到的「封面卡住」）。
      //
      // 2026-08-13 又换掉 glm-5.2：实测该模型在本 workspace 已 429
      // 「Workspace allocated quota exceeded」，直接不可用，封面这一步必然失败。
      //
      // 现用 deepseek-v4-flash，同一个 SenseNova 端点、同一把 key。
      // 2026-08-13 实测：3.6s、finish_reason=stop、JSON 一次通过。
      // （同日实测 sensenova-6.8-flash-lite 也能一次出合法 JSON、reasoning=0，
      //   但要 21s，是 deepseek 的近 6 倍，故不选它。）
      // 注意：本函数只读 message.content，不碰 reasoning 字段，
      // 所以两家模型 reasoning 字段名不同（6.8 叫 reasoning、deepseek 叫
      // reasoning_content）对这里没有影响。
      model: "deepseek-v4-flash",
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    }),
    signal: AbortSignal.timeout(60_000)
  });

  const payload = await response.json();
  if (response.status === 429 && retries > 0) {
    // 限流是暂时的，退避后重试；不该让一整轮封面白掉
    const waitMs = (4 - retries) * 8000;
    console.warn(`[cover] 触发限流，${waitMs / 1000}s 后重试（剩余 ${retries} 次）`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return generateCoverPrompts(keys, topic, script, retries - 1, maxTokens);
  }
  if (!response.ok) {
    throw new Error(`封面 prompt 生成失败（${response.status}）：${payload?.error?.message || "未知错误"}`);
  }

  const content = String(payload?.choices?.[0]?.message?.content || "").trim();
  const finish = payload?.choices?.[0]?.finish_reason;

  try {
    const result = parseCoverJson(content);
    if (!result.subtitle || !result.prompt_4_3 || !result.prompt_16_9) {
      throw new Error("缺少必要字段");
    }
    return result;
  } catch (error) {
    // 被截断（finish_reason=length）时，加大预算换一把 key 再试一次。
    // 模板兜底能出图，但副标题会退化成标题原文，诗意全无 —— 那是最后手段，
    // 不该因为 token 不够就直接放弃。
    if (finish === "length" && retries > 0) {
      console.warn(`[cover] 输出被截断（${content.length} 字符），加大 token 预算重试（剩余 ${retries} 次）`);
      return generateCoverPrompts(keys, topic, script, retries - 1, maxTokens * 2);
    }
    // 兜底：模型没给出可用 JSON（推理超预算、返回空、格式跑偏都算）时，
    // 用选题拼一份确定性 prompt。封面质量会平淡一些，但**总比没有封面强** ——
    // B 站缺封面直接发不出去。
    const reason = content ? `返回不可解析：${content.slice(0, 120)}` : "返回内容为空（推理占满 token 预算）";
    console.warn(`[cover] prompt 生成回退到模板 · ${reason}`);
    return buildFallbackPrompts(topic);
  }
}

/**
 * 无条件在提示词末尾追加「不要画任何文字」。
 *
 * system prompt 里已经要求过，但那是软约束、模型会漏。而漏了的代价很实在：
 * 照片上多出一行模型自己编的字，本地叠字再压上去，两层文字叠在一起。
 * 所以末尾再钉一次，中英文都写 —— 图片模型对英文关键词往往更敏感。
 */
function enforceNoText(prompt) {
  return `${String(prompt).trim()}。画面中不要出现任何文字、汉字、字母、数字、水印、logo、印章、签名。`
    + "no text, no letters, no words, no characters, no watermark, no logo, no typography, no captions, no signature.";
}

/** 不依赖模型的模板 prompt，作为 generateCoverPrompts 的兜底。 */
function buildFallbackPrompts(topic) {
  const title = String(topic).match(/标题[：:]\s*(.+)/)?.[1]?.trim()
    || String(topic).split("\n").find((line) => line.trim())?.trim()
    || "今夜安眠";
  const subtitle = title.slice(0, 12);
  const base = `柔和治愈的助眠冥想视频封面照片。画面左侧约四成是安静的深色暗部，没有主体也没有亮点，留给后期叠文字。右侧为一盏微弱暖琥珀色烛光照亮的小片区域，烛光落在古朴的木质表面上，光影温柔。深蓝与暗紫色渐变夜空背景，暖色微光从烛火处弥散。`
    + "真实感摄影，浅景深，主体锐利，背景柔和虚化。"
    + "vertical composition, very low light, moody and dim, soft bokeh, cinematic, film grain, dreamy, hypnotic sleep-inducing mood, no people, "
    + "no text, no letters, no words, no watermark, no logo, no typography, no captions";
  return {
    subtitle,
    prompt_4_3: `${base}，4:3 composition`,
    prompt_16_9: `${base}，16:9 wide composition`
  };
}

const MAIN_TITLE = "睡前冥想";

/**
 * 把主标题和副标题叠到照片上（本地渲染，不经过图片模型）。
 *
 * 为什么不让图片模型画字：实测四轮下来它三种错法都犯过 —— 副标题写成主标题的重复
 * （睡前冥想冥想）、把提示词里的引号画进图里（睡前冥想」）、把"四个字"这种说明也
 * 画进去（睡前冥想 四果）。加读图校验 + 三轮重试能把命中率提到 7/8，但仍有漏网的，
 * 而且**字号完全不可控**。
 *
 * 本地叠字之后文字是代码写上去的，不存在渲染错字，字号位置全部可控，
 * 所以那套校验和重试整个删掉了 —— 校验一个确定的东西没有意义。
 * 代价是文字不再"长在画面里"（少了被光晕影响的融合感），换来的是稳定。
 */
async function composeCoverText(photoPath, outputPath, subtitle, spec) {
  const args = [
    COMPOSE_SCRIPT, photoPath,
    "--title", MAIN_TITLE,
    "--subtitle", subtitle || "",
    "--output", outputPath,
    "--title-ratio", String(spec.titleRatio),
    "--subtitle-ratio", String(spec.subtitleRatio)
  ];
  // strict-font：字体不对就让这一步失败。封面字体错了不会报错、只是"看着不像"，
  // 而成品是要发出去的 —— 宁可这里红一次，也不要一批封面发完才发现字体不对。
  args.push("--strict-font");

  await new Promise((resolve, reject) => {
    // stdout 必须收。脚本最后那行会打印**实际用到的字体文件和 index**，
    // 那是唯一能确认拿到的是宋体而不是降级字体的信息。丢掉它，
    // 就等于在 CI 上永远无法判断封面字体对不对。
    const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(new Error(`叠字脚本起不来：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`叠字失败（退出码 ${code}）：${stderr.slice(-300)}`));
      }
      const line = stdout.trim().split("\n").pop();
      if (line) console.log(`  叠字：${line}`);
      if (stderr.trim()) console.log(`  叠字提示：${stderr.trim().slice(-300)}`);
      resolve();
    });
  });
}

/**
 * 用 SenseNova U1 Fast 生成一张图片
 */
/**
 * 从 PNG 头里读真实宽高。
 *
 * 不能再拿 COVER_SPECS.size 当结果报出去了：那是 U1 时代写死的像素值
 * （2368x1760 / 2752x1536），换成 Agnes 之后实际出的是 2304x1728 / 2624x1472。
 * 叠字脚本用的是真实尺寸，而返回给上层的元数据用的是写死的值 —— 同一张图
 * 两个数，清单里记的主标题字号能差 9px。宁可多读 24 个字节。
 *
 * PNG 的 IHDR 固定在最前面：8 字节签名 + 4 长度 + 4 类型，
 * 然后就是大端的宽和高各 4 字节。不引图像库。
 */
async function readPngSize(file) {
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    if (buf.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } finally {
    await fh.close();
  }
}

/**
 * 出一张封面照片。
 *
 * 2026-08-14 从 SenseNova U1 Fast 换成 Agnes（和正片画面同一个生图模型）。
 * 换的理由是**风格统一**：封面和视频画面出自同一个模型，观感才是一套的；
 * 两家模型各画各的，封面看着像另一个频道的。
 *
 * 接口形状不一样，得翻译一遍：
 *   U1     size: "2368x1760"        直接给像素
 *   Agnes  size: "2K", ratio: "4:3"  给档位 + 比例
 * 实测 Agnes 2K 档：4:3 → 2304×1728（27~34 秒），16:9 → 2624×1472。
 * 和原来的 2368×1760 / 2752×1536 差 3~5%，而 B 站封面最低只要 1146×717，
 * 所以这点差别没有实际影响。不用 1K 档是因为它只有 1152×864，掉得太多。
 */
async function generateImage(agnes, prompt, ratio) {
  const keys = agnes.apiKeys;
  // 一把不行就换下一把。限流（429）和额度问题都是按 key 算的，
  // 换 key 比在同一把上退避等待有效得多。最多试到把池子走一遍。
  let payload;
  let response;
  let lastError = "";
  for (let attempt = 0; attempt < Math.max(1, keys.length); attempt += 1) {
    response = await fetch(`${agnes.baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pickKey(keys, attempt)}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: agnes.imgModel,
        prompt,
        size: "2K",
        ratio,
        n: 1
      }),
      // 2K 档实测 27~34 秒，比 U1 慢；120 秒的上限留得够，
      // 而封面这一步是和视频生成并行跑的，慢一点不影响总时长。
      signal: AbortSignal.timeout(180_000)
    });
    payload = await response.json().catch(() => ({}));
    if (response.ok) break;
    lastError = `${response.status}：${payload?.error?.message || "未知错误"}`;
    if (attempt < keys.length - 1) {
      console.warn(`[cover] 第 ${attempt + 1} 把 key 出图失败（${lastError}），换下一把`);
    }
  }
  if (!response.ok) {
    throw new Error(`图片生成失败（试了 ${Math.max(1, keys.length)} 把 key）：${lastError}`);
  }

  const url = payload?.data?.[0]?.url;
  if (!url) throw new Error("图片 API 没有返回 URL");
  return url;
}

/**
 * 从 CDN URL 下载图片并保存到本地
 */
async function downloadImage(imageUrl, outputPath) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`图片下载失败：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
  return outputPath;
}

/**
 * 主入口：生成两张封面图并保存到桌面 bilibili 文件夹
 *
 * @param {object} text - 包含 topic, script, optimized 等字段的文本结果
 * @param {object} options - { onProgress }
 * @returns {{ subtitle, covers: [{name, path, size, aspect}] }}
 */
export async function generateCovers(text, { onProgress, config } = {}) {
  const progress = (event) => onProgress?.(event);

  // 没有密钥就在入口处直说。否则会先 401 退回模板 prompt，再 401 出图失败，
  // 最后只留下一串「封面生成未完成」，看不出根因其实是环境变量没设。
  // 出图走 Agnes，写 prompt 那步仍走 SenseNova（deepseek）—— 两批 key 不一样。
  const agnes = {
    baseUrl: String(config?.agnesHeadless?.baseUrl || "https://apihub.agnes-ai.cn").replace(/\/$/, ""),
    imgModel: config?.agnesHeadless?.imgModel || "agnes-image-2.1-flash",
    apiKeys: [...new Set((config?.agnesHeadless?.apiKeys || [])
      .map((k) => String(k || "").trim()).filter(Boolean))]
  };
  if (!agnes.apiKeys.length) {
    throw new Error("封面出图要用 Agnes，但 agnesHeadless.apiKeys 是空的（云端设 AGNES_API_KEYS）");
  }

  const keys = resolveKeys(config);
  if (!keys.length) {
    throw new Error("没有可用的 SenseNova key，无法生成封面。要么设 SENSENOVA_API_KEYS 环境变量（多把用逗号分隔），要么在 config.json 的 agnesHeadless.directorKeys / scorerKeys / motionKeys 里填 —— 三者任一即可。");
  }

  // 确保输出目录存在
  await mkdir(BILIBILI_DIR, { recursive: true });

  // 步骤 1：生成 prompt
  progress({ step: "cover", status: "running", progress: 55, message: "正在为封面图设计构图与副标题" });
  const prompts = await generateCoverPrompts(
    keys,
    String(text.topic || ""),
    String(text.script || "")
  );

  // 步骤 2：并行生成两张图
  progress({
    step: "cover",
    status: "running",
    progress: 56,
    message: `正在生成封面图 · 副标题：${prompts.subtitle}`,
    detail: "Agnes 2K · 4:3 + 16:9"
  });

  // 照片里不该有任何文字，无论 prompt 来自模型还是模板兜底都钉一遍
  const promptMap = {
    "4比3": enforceNoText(prompts.prompt_4_3),
    "16比9": enforceNoText(prompts.prompt_16_9)
  };

  // 出图 → 本地叠字。
  //
  // 没有校验、没有重试，因为没必要了：文字是本地代码写上去的，不可能出错。
  // 之前那套「读图核对 + 三轮重出」是为了兜住图片模型渲染中文的不确定性，
  // 现在源头没有不确定性了，校验一个确定的东西只是白花时间。
  const results = await Promise.all(
    COVER_SPECS.map(async (spec) => {
      const outputPath = path.join(BILIBILI_DIR, `${spec.name}.png`);
      const photoPath = path.join(BILIBILI_DIR, `.photo-${spec.name}.png`);
      const imageUrl = await generateImage(agnes, promptMap[spec.name], spec.aspect);
      await downloadImage(imageUrl, photoPath);
      try {
        await composeCoverText(photoPath, outputPath, prompts.subtitle, spec);
      } finally {
        // 中间的纯照片没有保留价值，叠完就删；失败也删，不留半成品在 B 站取图的目录里
        await unlink(photoPath).catch(() => {});
      }
      // 尺寸以**磁盘上那张图**为准，不用 COVER_SPECS 里写死的值
      const real = await readPngSize(outputPath);
      const h = real?.height || Number(spec.size.split("x")[1]);
      return {
        name: spec.name,
        path: outputPath,
        size: real ? `${real.width}x${real.height}` : spec.size,
        aspect: spec.aspect,
        titlePx: Math.round(h * spec.titleRatio),
        subtitlePx: Math.round(h * spec.subtitleRatio)
      };
    })
  );

  progress({
    step: "cover",
    status: "done",
    progress: 58,
    message: "封面图已生成，文字为本地渲染",
    detail: `副标题：${prompts.subtitle} · `
      + results.map((r) => `${r.name} 主标题 ${r.titlePx}px`).join(" / ")
      + ` · ${BILIBILI_DIR}`
  });

  return {
    subtitle: prompts.subtitle,
    covers: results,
    outputDir: BILIBILI_DIR
  };
}

/**
 * 删除封面图（发布完成后调用）
 */
export async function cleanupCovers() {
  const errors = [];
  for (const spec of COVER_SPECS) {
    const filePath = path.join(BILIBILI_DIR, `${spec.name}.png`);
    try {
      await unlink(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(`${spec.name}: ${error.message}`);
    }
  }
  if (errors.length) {
    console.error("清理封面图时部分失败：", errors.join("; "));
  }
}

export { BILIBILI_DIR, COVER_SPECS };
