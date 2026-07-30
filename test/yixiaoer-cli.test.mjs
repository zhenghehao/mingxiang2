import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureYixiaoerApiKey,
  inspectYixiaoerCli,
  listYixiaoerAccounts,
  resolveYixiaoerCli
} from "../src/yixiaoer-cli.mjs";

async function fakeYxer() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-fake-yxer-"));
  const file = path.join(root, "yxer");
  const marker = path.join(root, "configured");
  await writeFile(file, `#!/bin/sh
marker="${marker}"
if [ "$1" = "--version" ]; then printf '{"ok":true,"version":"3.2.4","data":{"version":"3.2.4"}}'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  if [ -f "$marker" ]; then present=true; else present=false; fi
  printf '{"ok":true,"data":{"apiKeyPresent":%s,"configPath":"%s/config.json","apiUrl":"https://example.invalid/api","localPublishClientId":""}}' "$present" "${root}"
  exit 0
fi
if [ "$1" = "config" ] && [ "$2" = "set-api-key" ]; then touch "$marker"; printf '{"ok":true,"data":{}}'; exit 0; fi
if [ "$1" = "doctor" ]; then printf '{"ok":true,"data":{"healthy":true}}'; exit 0; fi
if [ "$1" = "accounts" ]; then printf '{"ok":true,"data":{"items":[{"id":"a1","platform":"抖音","name":"测试账号","status":1}]}}'; exit 0; fi
printf '{"ok":false,"error":{"message":"unknown"}}'; exit 1
`, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("检测已安装但尚未配置的蚁小二 CLI", async () => {
  const executable = await fakeYxer();
  const config = { publishing: { cli: { path: executable } } };
  assert.equal(await resolveYixiaoerCli(config), executable);
  const status = await inspectYixiaoerCli(config);
  assert.equal(status.available, true);
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.version, "3.2.4");
});

test("配置 API Key 后可以检测连接并读取账号", async () => {
  const executable = await fakeYxer();
  const config = { publishing: { cli: { path: executable } } };
  const status = await configureYixiaoerApiKey(config, "test-key");
  assert.equal(status.connected, true);
  const accounts = await listYixiaoerAccounts(config, "抖音");
  assert.equal(accounts.data.items[0].name, "测试账号");
});
