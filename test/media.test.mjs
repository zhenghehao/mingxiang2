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
