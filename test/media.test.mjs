import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSequencedVideoPlan, resolveVideoProfile, selectDatedAsset } from "../src/media.mjs";

test("没有日期素材时回退到根目录媒体文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-media-"));
  const generic = path.join(root, "Velvet Silence.mp3");
  await writeFile(generic, "test");
  assert.equal(await selectDatedAsset(root, "2026-07-18", [".mp3"]), generic);
});

test("日期子文件夹素材优先于根目录通用素材", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-media-"));
  const datedRoot = path.join(root, "2026-07-18");
  await mkdir(datedRoot);
  await writeFile(path.join(root, "generic.mp4"), "generic");
  const dated = path.join(datedRoot, "night.mp4");
  await writeFile(dated, "dated");
  assert.equal(await selectDatedAsset(root, "2026-07-18", [".mp4"]), dated);
});

test("背景音乐可以在当前优先级目录中随机选择", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-random-audio-"));
  const first = path.join(root, "a.mp3");
  const second = path.join(root, "b.mp3");
  await Promise.all([writeFile(first, "a"), writeFile(second, "b")]);
  assert.equal(
    await selectDatedAsset(root, "2026-07-23", [".mp3"], { strategy: "random", random: () => 0.99 }),
    second
  );
});

test("视频默认使用适合发布的平衡体积设置", () => {
  assert.deepEqual(resolveVideoProfile({}), {
    id: "balanced",
    width: 720,
    height: 1280,
    fps: 24,
    crf: 26,
    preset: "medium",
    audioBitrate: "128k"
  });
});

test("视频可以切换回高清设置", () => {
  const profile = resolveVideoProfile({ videoQuality: "high" });
  assert.equal(profile.width, 1080);
  assert.equal(profile.height, 1920);
  assert.equal(profile.crf, 23);
});

test("Agnes 视频时间线只播放一次动态封面，随后循环纯净画面并在结尾淡黑", () => {
  assert.deepEqual(resolveSequencedVideoPlan(680, 5, 5), {
    totalDuration: 680,
    introDuration: 5,
    loopDuration: 675,
    endFadeSeconds: 5,
    fadeStart: 675
  });
});

test("结尾淡黑时间不会超过较短的音频长度", () => {
  assert.deepEqual(resolveSequencedVideoPlan(3, 5, 5), {
    totalDuration: 3,
    introDuration: 3,
    loopDuration: 0,
    endFadeSeconds: 3,
    fadeStart: 0
  });
});

// ── 背景音响度归一 ──────────────────────────────────────────────────────
//
// 曲库里 180 首本身响度不齐（实测随手两首差 1.2dB）。不归一的话，同一个
// bgmGainDb 换首曲子听感就变 —— 用户是拿其中一首定的音量，其余全部围着它摆。
test("响的曲子往下压，闷的往上抬，抬压量正好是与基准的差", async () => {
  const { resolveBgmGain } = await import("../src/media.mjs");
  // 基准 -17.3：比它响 1.2dB 的要少推 1.2dB
  assert.deepEqual(resolveBgmGain(-7, -16.1, -17.3),
    { gain: -8.2, normalized: true, delta: -1.2 });   // 取两位小数，不留浮点尾巴
  // 比它闷 1.2dB 的要多推 1.2dB
  assert.deepEqual(resolveBgmGain(-7, -18.5, -17.3),
    { gain: -5.8, normalized: true, delta: 1.2 });
  // 正好等于基准的不动
  assert.deepEqual(resolveBgmGain(-7, -17.3, -17.3),
    { gain: -7, normalized: true, delta: 0 });
});

test("量不出响度或没设基准时，退回原来的行为而不是把增益算成 NaN", async () => {
  const { resolveBgmGain } = await import("../src/media.mjs");
  // 这条是关键：算成 NaN 的话 volume=NaNdB 会让 ffmpeg 直接失败，
  // 而背景音响度不值得让整条流水线挂掉。
  for (const [measured, target] of [[null, -17.3], [-17.3, null], [null, null], [NaN, -17.3], [-17.3, undefined]]) {
    const r = resolveBgmGain(-7, measured, target);
    assert.equal(r.gain, -7, `measured=${measured} target=${target} 应当退回原增益`);
    assert.equal(r.normalized, false);
    assert.ok(Number.isFinite(r.gain), "增益必须是有限数");
  }
});

test("归一后两首响度不同的曲子，最终增益差应当抵消掉原始差值", async () => {
  const { resolveBgmGain } = await import("../src/media.mjs");
  const 响 = resolveBgmGain(-7, -16.1, -17.3).gain;
  const 闷 = resolveBgmGain(-7, -18.5, -17.3).gain;
  // 原始差 2.4dB，增益就该反向差 2.4dB，混出来才一样响
  assert.equal(Number((闷 - 响).toFixed(2)), 2.4);
});
