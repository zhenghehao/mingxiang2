import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTtsPacing,
  formatPublishingContext,
  isTransientTextError,
  resolveDurationPlan,
  resolveExtremeDurationPlan,
  sanitizeTtsText,
  TEXT_STAGE_RETRIES,
  TTS_DRIFT_TOLERANCE,
  ttsContentDrift,
  ttsPacingNeedsRetry
} from "../src/workflow.mjs";

// ── 只重试「没接通」，不重试「模型不接受」 ────────────────────────────────
test("超时和连接类失败要重试 —— 同样的请求再发一次可能就过了", () => {
  // 2026-08-10 实测：六篇里动漫那篇 420s 超时整篇丢掉，同批另外五篇都正常出稿。
  for (const msg of [
    "接口请求超时，请检查地址、网络或模型状态",
    "The operation was aborted due to timeout",
    "无法连接接口：fetch failed",
    "接口请求失败：503 upstream unavailable",
    "接口请求失败：429 rate limit exceeded",
    "无法连接接口：socket hang up",
    "接口返回了空内容（choices 在但 content 为空），可能是模型这次没有输出"
  ]) {
    assert.equal(isTransientTextError(new Error(msg)), true, `应当重试：${msg}`);
  }
  assert.equal(isTransientTextError(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
});

test("业务错误不重试 —— 重发一万次也是同一个错", () => {
  for (const msg of [
    "接口请求失败：401 invalid api key",
    "接口请求失败：404 model not found",
    "接口返回的不是 JSON，请确认它兼容 Chat Completions 格式",
    "接口已响应，但没有找到文本内容；可在高级设置中填写响应路径",
    "请先为“写作引擎”绑定 Skill"
  ]) {
    assert.equal(isTransientTextError(new Error(msg)), false, `不该重试：${msg}`);
  }
  assert.equal(isTransientTextError(null), false, "拿到空错误时不能当可重试，否则会空转到重试上限");
});

test("重试次数有限，不会无限转", () => {
  assert.ok(Number.isInteger(TEXT_STAGE_RETRIES) && TEXT_STAGE_RETRIES >= 1 && TEXT_STAGE_RETRIES <= 5);
});

// ── 篇幅是单边约束：够长就行，超了不管 ──────────────────────────────────
test("时长标尺只设下限，上限不作判定", () => {
  const plan = resolveDurationPlan(10);
  assert.equal(plan.minChars, 470, "下限＝targetChars 减 12%");
  assert.equal(plan.targetChars, 534);
  assert.equal(plan.floorOnly, true, "要显式标出这是单边约束，否则调用方会当区间判，写长了被误杀");
});

test("写超了放行，写短了才拦", () => {
  const { minChars } = resolveDurationPlan(10);
  // 实测三轮 482 / 511 / 502 字全部合格，出来却是 12.5 / 8.9 / 14.1 分钟 ——
  // 时长真正取决于停顿总量（507 / 276 / 558 秒），字数这把尺子只该管「别太短」。
  for (const chars of [470, 534, 900, 5000]) {
    assert.ok(chars >= minChars, `${chars} 字应当放行`);
  }
  assert.ok(469 < minChars, "差一个字也算不够");
});

test("各档下限随分钟数线性走，且都比中心值低 12%", () => {
  for (const minutes of [3, 10, 15, 20]) {
    const p = resolveDurationPlan(minutes);
    assert.equal(p.minChars, p.targetChars - Math.round(p.targetChars * 0.12));
    assert.ok(p.minChars < p.targetChars);
  }
});

// ── 转写的职责边界：只插停顿，不动内容 ──────────────────────────────────
//
// 下面几条用的是 work/runs 里 8 条真实记录的字数。守规矩的三条漂移正好 0.0%，
// 越权的三条是 10.8% / 12.5% / 25.8% —— 阈值必须把这两类分开。
const 原稿 = (n) => "字".repeat(n);

test("转写只插停顿标记时，漂移为 0", () => {
  const script = 原稿(586);
  const optimized = "字<#3.5#>".repeat(586);
  assert.equal(ttsContentDrift(script, optimized), 0);
  assert.ok(ttsContentDrift(script, optimized) <= TTS_DRIFT_TOLERANCE);
});

test("真实的三条守规矩记录都在容忍度内", () => {
  for (const chars of [572, 586, 655]) {
    assert.ok(ttsContentDrift(原稿(chars), 原稿(chars)) <= TTS_DRIFT_TOLERANCE);
  }
});

test("真实的三条越权记录都会被抓出来", () => {
  // 629→697 扩写、502→565 扩写、287→213 删内容。
  // 最后一条在旧口径（落没落进时长区间）下反而算合格 —— 砍完正好落进 170–216，
  // 这正是把篇幅考卷发给转写去做的后果，新口径必须能看见它。
  for (const [script, optimized] of [[629, 697], [502, 565], [287, 213]]) {
    assert.ok(
      ttsContentDrift(原稿(script), 原稿(optimized)) > TTS_DRIFT_TOLERANCE,
      `${script}→${optimized} 应当被判为越权`
    );
  }
});

test("英文标签转成中文带来的增量不会误判为越权", () => {
  // (inhale) 是 0 个中文字，轻轻吸气是 4 个 —— 这是转写的分内事，不该报警。
  const script = 原稿(500) + "(inhale)(exhale)(breath)";
  const optimized = 原稿(500) + "轻轻吸气缓缓呼气自然换气";
  assert.ok(ttsContentDrift(script, optimized) <= TTS_DRIFT_TOLERANCE);
});

test("原稿为空时漂移算 0，不当成异常", () => {
  // 复用配音文本重跑时原稿可能拿不到，这时无从比较，不能凭空报警。
  assert.equal(ttsContentDrift("", 原稿(500)), 0);
  assert.equal(ttsContentDrift(null, "随便什么"), 0);
});

test("MiniMax 配音文本会把英文呼吸动作标签转换成中文", () => {
  const input = "慢慢地，(inhale)<#4.0#>清凉的空气进入胸口。(EXHALE)<#5.0#>疲惫流走。";
  const output = sanitizeTtsText(input);
  assert.equal(output, "慢慢地，轻轻吸气<#4.0#>清凉的空气进入胸口。缓缓呼气<#5.0#>疲惫流走。");
  assert.doesNotMatch(output, /\((inhale|exhale)\)/i);
});

test("MiniMax 配音文本会清理其他英文声音动作标签", () => {
  const output = sanitizeTtsText("(breath) (sighs) (humming)");
  assert.equal(output, "自然换气 轻轻叹一口气 轻声哼唱");
});

test("长配音稿会检测明确停顿是否足够自然", () => {
  const rushed = `${"今晚可以慢慢放松下来。".repeat(90)}<#5.0#>`;
  const natural = `${"今晚可以慢慢放松下来。<#1.2#>".repeat(90)}`;
  const rushedStats = analyzeTtsPacing(rushed);
  const naturalStats = analyzeTtsPacing(natural);
  assert.equal(ttsPacingNeedsRetry(rushedStats), true);
  assert.equal(ttsPacingNeedsRetry(naturalStats), false);
  assert.ok(naturalStats.pauseSecondsPer100Chars >= 7);
});

test("极限滞后模式接受更高的长留白密度", () => {
  const extreme = { spokenChars: 1200, pauseSecondsPer100Chars: 28 };
  const approvedExtreme = { spokenChars: 2600, pauseSecondsPer100Chars: 85.8 };
  const excessive = { spokenChars: 2600, pauseSecondsPer100Chars: 95 };
  assert.equal(ttsPacingNeedsRetry(extreme, "extreme"), false);
  assert.equal(ttsPacingNeedsRetry(approvedExtreme, "extreme"), false);
  assert.equal(ttsPacingNeedsRetry(excessive, "extreme"), true);
  assert.equal(ttsPacingNeedsRetry(extreme, "natural"), true);
});

test("极限滞后模式按用户实听节点识别 10、15 和 20 分钟字数", () => {
  assert.deepEqual(resolveExtremeDurationPlan("晚上，10分钟", "minimax-meditation-tts-extreme-immersion"), {
    minutes: 10, targetChars: 534, minChars: 520, maxChars: 550
  });
  assert.deepEqual(resolveExtremeDurationPlan("晚上，10分钟左右，不必卡死时间", "minimax-meditation-tts-extreme-immersion"), {
    minutes: 10, targetChars: 534, minChars: 460, maxChars: 620, flexible: true
  });
  assert.deepEqual(resolveExtremeDurationPlan("晚上，15分钟", "minimax-meditation-tts-extreme-immersion"), {
    minutes: 15, targetChars: 778, minChars: 760, maxChars: 800
  });
  assert.deepEqual(resolveExtremeDurationPlan("晚上二十分钟", "minimax-meditation-tts-extreme-immersion"), {
    minutes: 20, targetChars: 1021, minChars: 1000, maxChars: 1050
  });
  assert.equal(resolveExtremeDurationPlan("晚上自然结束", "minimax-meditation-tts-extreme-immersion"), null);
});

// 原来这里测的是 formatYixiaoerPublishingContext（蚁小二第三方发布服务）。
// 那条集成早已换成本地 publisher，函数改名成 formatPublishingContext 且不再接收
// 在线账号列表，但测试没跟着改，于是一直是个 import 就炸的红灯。改成测现在这个。
test("发布文案上下文包含全部目标平台和各自的标题长度限制", () => {
  const output = formatPublishingContext();
  for (const platform of ["抖音", "快手", "小红书", "B站", "视频号", "喜马拉雅", "网易云播客"]) {
    assert.match(output, new RegExp(platform), `缺少平台 ${platform}`);
  }
  // 标题长度限制必须写进去：超限是实测踩过的发布失败原因
  assert.match(output, /小红书≤20字/);
  assert.match(output, /网易云6-16字/);
  assert.match(output, /喜马拉雅≤40字/);
});
