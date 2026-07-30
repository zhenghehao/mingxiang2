import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CODEX_MODELS, callCodexCliText, inspectCodexCli, resolveCodexCli } from "../src/codex-cli.mjs";

async function fakeCodex() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-fake-codex-"));
  const file = path.join(root, "codex");
  await writeFile(file, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli test"; exit 0; fi
if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift
done
cat >/dev/null
printf "连接成功" > "$output"
`, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("自动检测自定义 Codex CLI 并读取登录状态", async () => {
  const executable = await fakeCodex();
  const config = { textEngine: { codexCli: { path: executable, model: "gpt-5.6-terra" } } };
  assert.equal(await resolveCodexCli(config), executable);
  const status = await inspectCodexCli(config);
  assert.equal(status.available, true);
  assert.equal(status.connected, true);
  assert.equal(status.version, "codex-cli test");
});

test("完整展示本机可选模型并默认使用 Sol 高级推理", async () => {
  const executable = await fakeCodex();
  const status = await inspectCodexCli({ textEngine: { codexCli: { path: executable } } });
  assert.deepEqual(CODEX_MODELS.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini"
  ]);
  assert.equal(status.model, "gpt-5.6-sol");
  assert.equal(status.reasoningEffort, "high");
});

test("通过 Codex CLI 非交互模式取得最终文本", async () => {
  const executable = await fakeCodex();
  const config = {
    textEngine: {
      mode: "codex-cli",
      codexCli: { path: executable, model: "gpt-5.6-luna", reasoningEffort: "low", timeoutMs: 10_000 }
    }
  };
  const result = await callCodexCliText(config, "测试规则", "测试输入");
  assert.equal(result.text, "连接成功");
  assert.equal(result.engine, "codex-cli");
  assert.equal(result.model, "gpt-5.6-luna");
});
