/**
 * 环境变量覆盖层。
 *
 * 这个项目原本把「本机才有的东西」写死在两个地方：data/config.json 里的一串
 * /Users/shareit/... 绝对路径，以及源码里的明文密钥。两样都让它只能在这一台
 * Mac 上跑 —— 换台机器要挨个改，推上 GitHub 还会连密钥一起推。
 *
 * 这里把它们统一收口成环境变量：**设了就用环境变量，没设就回落到 config.json**。
 * 所以本机什么都不用动，行为完全不变；而在 CI 或服务器上，只要给够环境变量就能跑，
 * config.json 里可以一个绝对路径、一个密钥都不留。
 *
 * 只在这一层做覆盖，不在各模块里各读各的 —— 否则「这个值到底从哪来」会散成一片。
 */

/**
 * 分隔符列表 → 数组。顺手去空白、去空项、去重。
 *
 * 半角逗号、全角逗号「，」、顿号「、」、分号、换行、空格全都认。
 * 原来只认 /[,;\n]/ —— 在 GitHub Secrets 里用中文输入法打逗号是很自然的事，
 * 而全角逗号切不开会把整串当成一把 key，请求 401，报错只说「无效的令牌」，
 * 完全看不出是分隔符的问题。这种坑不该让填的人去躲。
 */
function splitList(raw) {
  return [...new Set(
    String(raw || "").split(/[,、，;；\s]+/).map((item) => item.trim()).filter(Boolean)
  )];
}

/** 按路径把值写进对象，中途缺的层级自动补上。 */
function setPath(target, dottedPath, value) {
  const keys = dottedPath.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== "object") node[key] = {};
    node = node[key];
  }
  node[keys.at(-1)] = value;
}

function getPath(source, dottedPath) {
  return dottedPath.split(".").reduce((node, key) => (node == null ? node : node[key]), source);
}

/** 环境变量名 → 配置里的位置。字符串类。 */
const STRING_VARS = {
  // 文本引擎三件套。CI 上没有 data/config.json（它被 gitignore 了），
  // 全靠 default-config.json + 这里的环境变量，所以这三项必须能被覆盖。
  TEXT_ENGINE_MODE: "textEngine.mode",
  TEXT_BASE_URL: "textProvider.baseUrl",
  TEXT_MODEL: "textProvider.model",
  // 音色 ID 不是密钥，但是账号特有的，换账号时要能不改代码就切
  MINIMAX_VOICE_ID: "minimax.voiceId",
  MINIMAX_MODEL: "minimax.model",
  MEDITATION_OUTPUT_ROOT: "app.outputRoot",
  MEDITATION_BGM_ROOT: "media.bgmRoot",
  MEDITATION_VIDEO_ROOT: "media.videoRoot",
  MEDITATION_COVER_DIR: "media.coverDir",
  AGNES_PROJECT_ROOT: "agnes.projectRoot",
  AGNES_BASE_URL: "agnesHeadless.baseUrl",
  AGNES_COVER_PATH: "agnesHeadless.coverPath",
  AGNES_OUTPUT_DIR: "agnesHeadless.outputDir",
  AGNES_TEXT_MODEL: "agnesHeadless.textModel",
  AGNES_IMAGE_MODEL: "agnesHeadless.imgModel",
  AGNES_VIDEO_MODEL: "agnesHeadless.vidModel",
  // 评委和运动导演走的是 SenseNova，不是 Agnes —— 它们只是服务于 Agnes
  // 那条视觉流水线，所以配置字段挂在 agnesHeadless 下面。但环境变量名要说明
  // 「这是什么」而不是「谁在用」，否则填 secret 时会去找 Agnes 的 key，填错。
  SENSENOVA_SCORER_URL: "agnesHeadless.scorerUrl",
  SENSENOVA_MOTION_URL: "agnesHeadless.motionUrl"
};

/** 列表类：逗号/换行分隔。 */
const LIST_VARS = {
  MEDITATION_SKILL_ROOTS: "skillRoots",
  AGNES_API_KEYS: "agnesHeadless.apiKeys",
  AGNES_VIDEO_KEYS: "agnesHeadless.videoKeys",
  SENSENOVA_SCORER_KEYS: "agnesHeadless.scorerKeys",
  SENSENOVA_MOTION_KEYS: "agnesHeadless.motionKeys"
};

/** 数字类。 */
const NUMBER_VARS = {
  AGNES_CANDIDATE_COUNT: "agnesHeadless.candidateCount",
  AGNES_RESERVED_FOR_VIDEO: "agnesHeadless.reservedForVideo"
};

/** 布尔类：只有明确写 true/1/yes 才算开。 */
const BOOL_VARS = {
  AGNES_HEADLESS_ENABLED: "agnesHeadless.enabled"
};

export function applyEnvOverrides(config, env = process.env) {
  const merged = structuredClone(config);
  const applied = [];

  for (const [name, target] of Object.entries(STRING_VARS)) {
    const raw = env[name];
    if (raw == null || raw === "") continue;
    setPath(merged, target, String(raw).trim());
    applied.push(name);
  }
  for (const [name, target] of Object.entries(LIST_VARS)) {
    const raw = env[name];
    if (raw == null || raw === "") continue;
    const list = splitList(raw);
    if (!list.length) continue;
    setPath(merged, target, list);
    applied.push(name);
  }
  for (const [name, target] of Object.entries(NUMBER_VARS)) {
    const raw = Number(env[name]);
    if (!Number.isFinite(raw)) continue;
    setPath(merged, target, raw);
    applied.push(name);
  }
  for (const [name, target] of Object.entries(BOOL_VARS)) {
    const raw = env[name];
    if (raw == null || raw === "") continue;
    setPath(merged, target, /^(1|true|yes|on)$/i.test(String(raw).trim()));
    applied.push(name);
  }

  return { config: merged, applied };
}

/**
 * 列出配置里还残留的本机绝对路径。
 *
 * 搬到别的机器（或 CI）时，这些就是会当场炸掉的地方。启动时打一条提醒，
 * 好过跑到一半才报一个「找不到素材目录」而看不出根因。
 */
export function localOnlyPaths(config) {
  const checks = [
    ["app.outputRoot", "MEDITATION_OUTPUT_ROOT"],
    ["media.bgmRoot", "MEDITATION_BGM_ROOT"],
    ["media.videoRoot", "MEDITATION_VIDEO_ROOT"],
    ["agnes.projectRoot", "AGNES_PROJECT_ROOT"]
  ];
  const found = [];
  for (const [dotted, envName] of checks) {
    const value = getPath(config, dotted);
    if (typeof value === "string" && /^\/(Users|home)\//.test(value)) {
      found.push({ path: dotted, value, env: envName });
    }
  }
  const roots = Array.isArray(config.skillRoots) ? config.skillRoots : [];
  if (roots.some((item) => /^\/(Users|home)\//.test(String(item)))) {
    found.push({ path: "skillRoots", value: `${roots.length} 个目录`, env: "MEDITATION_SKILL_ROOTS" });
  }
  return found;
}
