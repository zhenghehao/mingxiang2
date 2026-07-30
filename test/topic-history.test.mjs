import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractTopicRecord, findDuplicateTopic, loadTopicHistory, recordTopic } from "../src/topic-history.mjs";

const topic = (title, preview = "一段全新的安静旅程") => `标题：${title}\n主题族：星空·夜\n时段：晚上\n目标时长：10分钟\nmode：full\nwake：false\n画面预览：${preview}`;

test("能从自动选题结果中提取标题与参数", () => {
  const record = extractTopicRecord(topic("云端钟楼"));
  assert.equal(record.title, "云端钟楼");
  assert.equal(record.period, "晚上");
  assert.equal(record.themeFamily, "星空·夜");
});

test("会拒绝与历史标题相同或高度相似的选题", () => {
  const history = [extractTopicRecord(topic("月光潮汐"))];
  assert.equal(findDuplicateTopic(extractTopicRecord(topic("月光潮汐")), history)?.title, "月光潮汐");
  assert.equal(findDuplicateTopic(extractTopicRecord(topic("竹林晨风")), history), null);
});

test("扫描旧输出并把新题目写入桌面选题库", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-history-"));
  const oldDir = path.join(root, "outputs", "old", "文本");
  await mkdir(oldDir, { recursive: true });
  await writeFile(path.join(oldDir, "01-选题结果.txt"), topic("月光潮汐"), "utf8");
  const config = { app: { outputRoot: "output" } };
  const existing = await loadTopicHistory(config, root);
  assert.equal(existing.some((item) => item.title === "月光潮汐"), true);
  const saved = await recordTopic(config, root, topic("竹林晨风"));
  assert.equal(saved.count, 2);
  const next = await loadTopicHistory(config, root);
  assert.deepEqual(next.map((item) => item.title).sort(), ["月光潮汐", "竹林晨风"].sort());
});
