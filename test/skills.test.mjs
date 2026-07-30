import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSkillById, scanSkills } from "../src/skills.mjs";

test("扫描并读取最新 SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-skills-"));
  const dir = path.join(root, "topic-skill");
  await mkdir(dir);
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, "---\nname: topic-maker\ndescription: 生成选题\n---\n\n第一版", "utf8");
  const first = await scanSkills([root]);
  assert.equal(first.length, 1);
  assert.equal(first[0].name, "topic-maker");
  const loaded = await readSkillById([root], first[0].id);
  assert.match(loaded.content, /第一版/);
  await writeFile(file, "---\nname: topic-maker\ndescription: 生成选题\n---\n\n第二版", "utf8");
  const second = await readSkillById([root], first[0].id);
  assert.match(second.content, /第二版/);
  assert.notEqual(second.version, loaded.version);
});

test("兼容文件名带 SKILL 的独立 Markdown 与折叠描述", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sleepflow-loose-skills-"));
  const file = path.join(root, "助眠选题器-SKILL 2.md");
  await writeFile(file, "---\nname: sleep-topic-picker\ndescription: >-\n  第一行描述。\n  第二行描述。\nversion: 1.0\n---\n\n# 选题", "utf8");
  const skills = await scanSkills([root]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "sleep-topic-picker");
  assert.equal(skills[0].description, "第一行描述。 第二行描述。");
  assert.equal(skills[0].format, "compatible-file");
});
