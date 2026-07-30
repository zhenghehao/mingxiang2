import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { callTextEngine } from "./providers.mjs";
import { resolveSlots } from "./skills.mjs";

export const COMPARE_STAGES = [
  { id: "topic", slot: "topic", label: "选题", filename: "01-选题结果.txt" },
  { id: "script", slot: "script", label: "催眠冥想原稿", filename: "02-催眠冥想原稿.txt" },
  { id: "tts", slot: "ttsOptimizer", label: "MiniMax 最终配音文本", filename: "03-MiniMax最终配音文本.txt" },
  { id: "copy", slot: "copywriter", label: "跨平台发布文案", filename: "04-跨平台发布文案.txt" }
];

const RUNTIME_RULES = {
  topic: `当前是无人值守对比测试。用户已授权你自行选择题目，不要提问、不要给候选列表、不要等待选择。严格按照 Skill 选出一个晚间成人催眠冥想主题，默认约 15 分钟、mode=full、wake=false。只输出最终选题、主题族、时段、目标时长、mode、wake、受众和一句画面预览。`,
  script: `当前要生成晚上收听的成人完整催眠冥想原稿。必须使用共享记忆中的最终选题，参数为 mode=full、wake=false、title=true，目标约 15 分钟。严格执行 Skill 的安全规则与夜间结尾铁律。只输出标题和可直接朗读的完整正文，不输出写作说明、参数表、Markdown 代码围栏或质检报告。`,
  tts: `当前只测试文本，不调用语音接口。把共享记忆中的完整原稿加工成可直接放入 MiniMax T2A text 字段的最终文本。插入合法的 <#x#> 停顿与必要的 (inhale)/(exhale) 标签；停顿标记不得连续，且不得放在文本最开头或最末尾。只输出最终配音文本，不输出 JSON、curl、参数说明、标题或代码围栏。`,
  copy: `根据共享记忆中的选题、原稿和最终配音文本生成跨平台专业发布文案。分析时清除所有 TTS 标记。严格按照 Skill 的完整输出格式，只输出一个合法 JSON 对象，不输出 Markdown 代码围栏或任何额外说明。`
};

function cleanMemory(memory = {}) {
  return Object.fromEntries(COMPARE_STAGES.map((stage) => [stage.id, String(memory?.[stage.id] || "").trim()]));
}

function buildSharedMemory(input, memory, stageId) {
  const sections = [
    "# 本次任务与共享记忆",
    `日期：${String(input?.date || "未指定")}`,
    `创作要求：${String(input?.brief || "晚上成人催眠冥想，题目由模型选择")}`
  ];
  for (const stage of COMPARE_STAGES) {
    if (stage.id === stageId) break;
    if (memory[stage.id]) sections.push(`\n## 已完成步骤：${stage.label}\n${memory[stage.id]}`);
  }
  sections.push(`\n# 当前任务\n${RUNTIME_RULES[stageId]}`);
  return sections.join("\n");
}

function requiredPrevious(stageId) {
  if (stageId === "script") return "topic";
  if (stageId === "tts") return "script";
  if (stageId === "copy") return "tts";
  return null;
}

export async function compareInfo(config) {
  const slots = await resolveSlots(config);
  return {
    stages: COMPARE_STAGES.map((stage) => ({
      ...stage,
      skill: slots[stage.slot] ? {
        id: slots[stage.slot].id,
        name: slots[stage.slot].name,
        version: slots[stage.slot].version,
        file: slots[stage.slot].file
      } : null
    }))
  };
}

export async function testCompareProvider(config, provider) {
  const started = Date.now();
  const result = await callTextEngine(
    config,
    provider,
    "这是本地 API 连通性测试。不要解释，只按要求回复。",
    "只回复四个字：连接成功",
    // 测试时关闭 thinking 模式，避免 reasoning 消耗全部输出 token 导致 content 为空；
    // 真实生成时不传 disableThinking，模型保持默认深度思考。
    { mode: "api", maxTokens: 256, timeoutMs: 45_000, disableThinking: true }
  );
  return { ok: true, latencyMs: Date.now() - started, reply: result.text.slice(0, 120), model: result.model };
}

export async function runCompareStep(config, payload) {
  const stage = COMPARE_STAGES.find((item) => item.id === payload?.stage);
  if (!stage) throw new Error("未知的工作流步骤");
  const memory = cleanMemory(payload?.memory);
  const required = requiredPrevious(stage.id);
  if (required && !memory[required]) {
    const label = COMPARE_STAGES.find((item) => item.id === required)?.label;
    throw new Error(`请先完成上一步：${label}`);
  }
  const slots = await resolveSlots(config);
  const skill = slots[stage.slot];
  if (!skill) throw new Error(`“${stage.label}”尚未绑定 Skill`);
  const system = `${skill.content}\n\n# 眠屿工作台运行约定\n${RUNTIME_RULES[stage.id]}`;
  const input = buildSharedMemory(payload?.input, memory, stage.id);
  const result = await callTextEngine(config, payload?.provider, system, input, {
    mode: payload?.textEngine?.mode || config?.textEngine?.mode
  });
  return {
    stage: stage.id,
    label: stage.label,
    filename: stage.filename,
    output: result.text,
    elapsedMs: result.elapsedMs,
    engine: {
      mode: result.engine,
      model: result.model,
      reasoningEffort: result.reasoningEffort,
      version: result.version
    },
    skill: { name: skill.name, version: skill.version, file: skill.file }
  };
}

export async function readCompareBaseline(workspaceRoot) {
  const folder = path.join(workspaceRoot, "outputs", "夜间催眠冥想文本测试-月光夜航");
  const entries = await Promise.all(COMPARE_STAGES.map(async (stage) => {
    try {
      return [stage.id, await readFile(path.join(folder, stage.filename), "utf8")];
    } catch {
      return [stage.id, ""];
    }
  }));
  return { folder, outputs: Object.fromEntries(entries) };
}

function safeFolderName(value) {
  return String(value || "api-compare")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "api-compare";
}

export async function saveCompareOutputs(workspaceRoot, payload) {
  const memory = cleanMemory(payload?.memory);
  const missing = COMPARE_STAGES.filter((stage) => !memory[stage.id]).map((stage) => stage.label);
  if (missing.length) throw new Error(`还缺少这些结果：${missing.join("、")}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const folder = path.join(workspaceRoot, "outputs", "api-compare", `${safeFolderName(payload?.name)}-${stamp}`);
  await mkdir(folder, { recursive: true });
  const files = await Promise.all(COMPARE_STAGES.map(async (stage) => {
    const file = path.join(folder, stage.filename);
    await writeFile(file, `${memory[stage.id].trim()}\n`, "utf8");
    return file;
  }));
  return { folder, files };
}
