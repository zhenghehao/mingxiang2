import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeTtsPacing,
  formatPublishingContext,
  resolveExtremeDurationPlan,
  sanitizeTtsText,
  ttsPacingNeedsRetry
} from "../src/workflow.mjs";

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
