import assert from "node:assert/strict";
import test from "node:test";
import { resolvePeriod } from "../src/workflow.mjs";

test("时段判定：中午的几种说法都认得", () => {
  for (const brief of ["中午的午休冥想", "午间小憩", "午休放松", "给上班族的中午冥想"]) {
    assert.equal(resolvePeriod(brief), "中午", brief);
  }
});

test("时段判定：其余一律算晚上", () => {
  for (const brief of ["睡前冥想", "深夜helpers", "", "   ", null, undefined, 0]) {
    assert.equal(resolvePeriod(brief), "晚上", String(brief));
  }
});

test("时段判定：写稿和封面必须共用这一个函数", async () => {
  // 这条防的是「两处各判各的」——稿子按中午写、片头却叠了晚上的蓝版，
  // 成品自己跟自己矛盾，而且两边都不报错。
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/workflow.mjs", import.meta.url), "utf8");
  const 自己判的 = src.match(/\/中午\|午休\|午间\//g) || [];
  assert.equal(自己判的.length, 1, "时段的正则只该出现在 resolvePeriod 里这一处");
  assert.ok(/startAgnesVisualTask\([^)]*resolvePeriod\(input\.brief\)\)/s.test(src),
    "视觉流水线必须拿到 resolvePeriod 算出来的时段");
});
