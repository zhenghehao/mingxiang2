import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = await readFile(new URL("../src/agnes-headless.mjs", import.meta.url), "utf8");
// 按函数边界切，不按字数切。
// 按字数切踩过坑：429 那段的 500 字窗口会溢进后面的 `if (!response.ok)` 块
// （那里本来就有 consecutiveErrors += 1），断言假红；而 queue_full 的第一次出现
// 是在注释里，从那儿数 600 字根本够不到真正的代码。
function 取函数(名) {
  const i = src.indexOf(名);
  if (i < 0) throw new Error(`源码里找不到 ${名}`);
  const j = src.indexOf("\nasync function ", i + 1);
  const k = src.indexOf("\nexport async function ", i + 1);
  const end = Math.min(...[j, k].filter((x) => x > 0));
  return src.slice(i, Number.isFinite(end) ? end : src.length);
}
const poll = 取函数("async function pollVideo");
const gen = 取函数("export async function genVideo");

test("轮询预算按时间算，不按次数算", () => {
  // 按次数算时，退避会让「同样的次数」代表完全不同的时长 ——
  // 2026-08-18 实测：查询被 429 退避几次后次数就用完了，报「轮询超时」，
  // 而视频其实还在正常生成。
  assert.match(poll, /const 预算Ms = agnes\.videoPollMax \* agnes\.videoPollIntervalMs/);
  assert.match(poll, /while \(Date\.now\(\) < 截止\)/);
  assert.doesNotMatch(poll, /for \(let i = 0; i < agnes\.videoPollMax/, "不该再按次数循环");
});

test("查询被 429 时放慢间隔，且不算作连续失败", () => {
  const i = poll.indexOf("response.status === 429");
  const seg = poll.slice(i, poll.indexOf("if (!response.ok)", i));   // 切到下一个分支为止
  assert.match(seg, /间隔 = Math\.min\(60_000/, "要有退避，并且封顶");
  assert.doesNotMatch(seg, /consecutiveErrors \+= 1/, "429 是「我们问得太勤」，不是故障，不能计入判死的计数");
  assert.match(poll, /间隔 = agnes\.videoPollIntervalMs;/, "查通之后要把间隔收回基准");
});

test("队列满（503）退避重试同一把 key，而不是换 key", () => {
  assert.match(gen, /queue_full\|queue is full/, "要认出队列满这种特定失败");
  const i = gen.indexOf("if (response.status === 503");           // 跳过注释里的那次出现
  const seg = gen.slice(i, gen.indexOf("continue;", i));
  assert.match(seg, /await sleep\(队列等待Ms/, "队列满要等，不是立刻重试");
  assert.match(seg, /attempt -= 1/, "队列是全局的，和 key 无关，不该因此跳到下一把");
  assert.match(seg, /队列重试次数 > 5/, "但也不能无限等");
});

test("默认配置：三处分辨率必须一致，都是 1080 级", async () => {
  const cfg = JSON.parse(await readFile(new URL("../data/default-config.json", import.meta.url), "utf8"));
  // 只改导出不改生成，等于把 720 的源放大 —— 这个组合出现过，要挡住
  assert.equal(cfg.media.videoQuality, "high", "导出档位");
  assert.match(src, /size: "2K"/, "出图要 2K（1K 是 736x1312，比 1080 还小）");
  assert.match(src, /Number\(agnes\.width\) \|\| 1080/, "出视频要跟着配置走，不能写死 720");
  assert.doesNotMatch(src, /width: 720, height: 1280/, "不该再有写死的 720x1280");
});

test("轮询预算够 1080 用（至少 15 分钟）", async () => {
  const cfg = JSON.parse(await readFile(new URL("../data/default-config.json", import.meta.url), "utf8"));
  const a = cfg.agnesHeadless;
  const 分钟 = a.videoPollMax * a.videoPollIntervalMs / 60000;
  assert.ok(分钟 >= 15, `轮询预算只有 ${分钟} 分钟，1080 生成不够用`);
  assert.ok(a.videoPollIntervalMs >= 6000, "间隔太短会被 429（实测 3 秒就会）");
});
