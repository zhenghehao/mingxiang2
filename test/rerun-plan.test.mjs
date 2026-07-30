import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RERUN_PLAN } from "../src/workflow.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * RERUN_PLAN 是后端真正执行的依据，public/app.js 的 RERUN_HINT 是给用户看的文案。
 * 两边一旦对不上，界面就会承诺一件后端不会做的事（或者反过来，悄悄多做一堆事）。
 * 这个文件锁住两者的一致性，以及那些「便宜档不许碰贵环节」的关键约束。
 */

async function readRerunHint() {
  const source = await readFile(path.join(ROOT, "public/app.js"), "utf8");
  const start = source.indexOf("const RERUN_HINT = {");
  assert.notEqual(start, -1, "public/app.js 里找不到 RERUN_HINT");
  const end = source.indexOf("\n};", start);
  const body = source.slice(start + "const RERUN_HINT = {".length, end);
  // 只取每一项的键名和 affects 数组，不求完整解析
  const entries = {};
  for (const match of body.matchAll(/(\w+)\s*:\s*\{[^}]*affects:\s*\[([^\]]*)\]/g)) {
    entries[match[1]] = match[2]
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return entries;
}

test("RERUN_HINT 和 RERUN_PLAN 覆盖同一组步骤", async () => {
  const hint = await readRerunHint();
  assert.deepEqual(Object.keys(hint).sort(), Object.keys(RERUN_PLAN).sort());
});

test("界面提示的「连带重做」数量和后端计划一致", async () => {
  const hint = await readRerunHint();
  // 后端的连带项 = 除自己以外真正要重做的阶段。两处折算：
  //   visuals → video：看板上「生成并导出视频」是一步，内部才分 Agnes 出图和 ffmpeg 导出。
  //   files：runAll 里无条件执行，界面不把它算作「连带」。
  const toBoardStep = (stage) => (stage === "visuals" ? "video" : stage);
  for (const [from, plan] of Object.entries(RERUN_PLAN)) {
    const downstream = [...new Set([...plan.text, ...plan.media].map(toBoardStep))]
      .filter((stage) => stage !== from && stage !== "files");
    assert.equal(
      hint[from].length,
      downstream.length,
      `「${from}」后端会重做 ${downstream.join("/") || "（无）"}，界面却写了 ${hint[from].length} 项`
    );
  }
});

test("便宜档绝不碰人声、混音和 Agnes 画面", () => {
  for (const from of ["copy", "cover", "files", "publish"]) {
    for (const expensive of ["voice", "audio", "visuals", "video"]) {
      assert.ok(
        !RERUN_PLAN[from].media.includes(expensive),
        `「${from}」是叶子步骤，不该重做 ${expensive}`
      );
    }
  }
});

test("换 BGM / 换人声只重导视频，不让 Agnes 重跑", () => {
  for (const from of ["audio", "voice", "tts"]) {
    assert.ok(RERUN_PLAN[from].media.includes("video"), `${from} 必须重导视频（时长变了）`);
    assert.ok(
      !RERUN_PLAN[from].media.includes("visuals"),
      `${from} 不该触发 Agnes 重跑 —— 那要多等 20–40 分钟`
    );
  }
});

test("原稿变了 Agnes 必须重跑：画面是按 text.script 生成的", () => {
  for (const from of ["topic", "script"]) {
    assert.ok(RERUN_PLAN[from].media.includes("visuals"), `${from} 改了原稿，画面必须重做`);
  }
});

test("任何改了配音文本的档都必须重合成人声", () => {
  for (const [from, plan] of Object.entries(RERUN_PLAN)) {
    if (!plan.text.includes("tts")) continue;
    assert.ok(
      plan.media.includes("voice"),
      `「${from}」重写了配音文本却不重合成人声，成品音频会和文本对不上`
    );
  }
});

test("重跑发布不重做任何生成环节", () => {
  assert.deepEqual(RERUN_PLAN.publish.text, []);
  assert.deepEqual(RERUN_PLAN.publish.media, []);
});
