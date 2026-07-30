import test from "node:test";
import assert from "node:assert/strict";
import { chooseMediaDirectory, isDirectoryPickerCancellation } from "../src/directory-picker.mjs";

test("通过 macOS 文件夹选择器返回规范化路径", async () => {
  const result = await chooseMediaDirectory("bgm", {
    platform: "darwin",
    execFile: async (file, args) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.match(args.join(" "), /选择背景音乐文件夹/);
      return { stdout: "/tmp/助眠音乐/\n" };
    }
  });
  assert.deepEqual(result, { cancelled: false, path: "/tmp/助眠音乐" });
});

test("取消文件夹选择时保留当前配置", async () => {
  const cancellation = Object.assign(new Error("User canceled."), {
    code: 1,
    stderr: "execution error: User canceled. (-128)"
  });
  assert.equal(isDirectoryPickerCancellation(cancellation), true);
  const result = await chooseMediaDirectory("video", {
    platform: "darwin",
    execFile: async () => { throw cancellation; }
  });
  assert.deepEqual(result, { cancelled: true, path: "" });
});

test("拒绝未知的素材库类型", async () => {
  await assert.rejects(() => chooseMediaDirectory("other"), /未知的素材库类型/);
});
