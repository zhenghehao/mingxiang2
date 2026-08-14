import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteOutputRun, listOutputRuns, resolveDeletableRun } from "../src/output-store.mjs";

async function 造一个成品目录() {
  const root = await mkdtemp(path.join(os.tmpdir(), "output-store-"));
  const one = path.join(root, "2026-08-13", "听雨落进苔藓的夜晚");
  await mkdir(path.join(one, "音频"), { recursive: true });
  await mkdir(path.join(one, "文本"), { recursive: true });
  await writeFile(path.join(one, "音频", "成品.mp3"), Buffer.alloc(2048));
  await writeFile(path.join(one, "文本", "text.json"), "{}");
  return { root, one };
}

// ── 能删的 ──────────────────────────────────────────────────────────────
test("正常的「日期/标题」可以解析出绝对路径", () => {
  const full = resolveDeletableRun("/tmp/out", "2026-08-13/夜里的渡船");
  assert.equal(full, path.resolve("/tmp/out/2026-08-13/夜里的渡船"));
});

test("列表能报出体积、文件数和媒体占比", async () => {
  const { root } = await 造一个成品目录();
  try {
    const runs = await listOutputRuns(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].relPath, "2026-08-13/听雨落进苔藓的夜晚");
    assert.equal(runs[0].files, 2);
    assert.ok(runs[0].bytes >= 2048, "体积要把音频算进去");
    assert.equal(runs[0].mediaBytes, 2048, "mp3 算媒体，text.json 不算");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("删掉之后目录真的没了，并报出省了多少", async () => {
  const { root, one } = await 造一个成品目录();
  try {
    const result = await deleteOutputRun(root, "2026-08-13/听雨落进苔藓的夜晚");
    assert.equal(result.deletedFiles, 2);
    assert.ok(result.deletedBytes >= 2048);
    assert.equal(await stat(one).then(() => true).catch(() => false), false, "目录应当已经不存在");
    // 上一层的日期目录要留着 —— 删的是一集，不是一整天
    assert.ok(await stat(path.join(root, "2026-08-13")).then(() => true).catch(() => false));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 必须拦住的 ──────────────────────────────────────────────────────────
//
// 这一组是这个模块存在的全部理由。每一条都必须**真的抛错**，
// 而不是打一行日志然后照删不误。
test("层数不对的一律拒绝", () => {
  for (const bad of [
    "",                              // 空
    "   ",                           // 只有空白
    "2026-08-13",                    // 只到日期那层 —— 删了就是一整天没了
    "2026-08-13/夜里的渡船/音频",     // 太深
    "a/b/c/d",
  ]) {
    assert.throws(() => resolveDeletableRun("/tmp/out", bad), /只能删除|没有指定/,
      `「${bad}」应当被拒绝`);
  }
});

test("跳出 output 的各种写法都拒绝", () => {
  for (const bad of [
    "../etc",
    "2026-08-13/..",
    "../../etc/passwd",
    "./..",
    "..\\\\..\\\\windows",           // 反斜杠也要按分隔符算，不能绕过段数检查
  ]) {
    assert.throws(() => resolveDeletableRun("/tmp/out", bad),
      /只能删除|不允许出现|不在 output/, `「${bad}」应当被拒绝`);
  }
});

test("塞绝对路径进来也拒绝", () => {
  assert.throws(() => resolveDeletableRun("/tmp/out", "/etc/passwd"), /不是绝对路径/);
  assert.throws(() => resolveDeletableRun("/tmp/out", "/tmp/别处/东西"), /不是绝对路径/);
  assert.throws(() => resolveDeletableRun("/tmp/out", "/"), /不是绝对路径/);
});

test("软链指向 output 之外时，删除必须在动手前拦下", async () => {
  // 字符串校验会放过它（路径长得完全正常），只有 realpath 能识破。
  // 这条要是没拦住，删掉的是软链指向的真实目录。
  const root = await mkdtemp(path.join(os.tmpdir(), "output-store-"));
  const 外面 = await mkdtemp(path.join(os.tmpdir(), "别处-"));
  const 珍贵文件 = path.join(外面, "不能删.txt");
  await writeFile(珍贵文件, "重要");
  await mkdir(path.join(root, "2026-08-13"), { recursive: true });
  await symlink(外面, path.join(root, "2026-08-13", "看起来正常"));
  try {
    await assert.rejects(
      () => deleteOutputRun(root, "2026-08-13/看起来正常"),
      /不在 output 目录内/);
    assert.ok(await stat(珍贵文件).then(() => true).catch(() => false),
      "软链外面的文件必须原封不动");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(外面, { recursive: true, force: true });
  }
});

test("删不存在的东西要报错，而不是静默成功", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "output-store-"));
  try {
    await assert.rejects(() => deleteOutputRun(root, "2026-01-01/根本没有"), /不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("目标是文件不是目录时拒绝", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "output-store-"));
  await mkdir(path.join(root, "2026-08-13"), { recursive: true });
  await writeFile(path.join(root, "2026-08-13", "只是个文件.txt"), "x");
  try {
    await assert.rejects(() => deleteOutputRun(root, "2026-08-13/只是个文件.txt"), /不是目录/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
