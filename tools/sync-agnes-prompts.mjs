/**
 * 把 agnes-playground.html 里的三段系统提示词重新同步到 src/agnes-prompts.mjs。
 *
 * 那三段（导演 / 运动导演 / 评委）是调出来的，一个字的改动都可能改变模型行为，
 * 所以 headless 版不重写、不精简，原样搬。上游那份 HTML 改了以后跑这个脚本，
 * 不要手动去改 src/agnes-prompts.mjs。
 *
 * 用法：
 *   node tools/sync-agnes-prompts.mjs [agnes-playground.html 的路径]
 * 不给路径时按 data/config.json 里的 agnes.projectRoot 找。
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WANTED = ["SKILL_DIRECTOR", "SKILL_MOTION", "SKILL_JUDGE"];

async function resolveSource(argv) {
  if (argv[2]) return path.resolve(argv[2]);
  const config = JSON.parse(await readFile(path.join(ROOT, "data/config.json"), "utf8"));
  const projectRoot = config?.agnes?.projectRoot;
  if (!projectRoot) throw new Error("config.json 里没有 agnes.projectRoot，请把 HTML 路径作为参数传进来");
  return path.join(projectRoot, "agnes-playground.html");
}

/** 从 `function NAME(` 起，一直到下一个顶格的 function / 注释块为止。 */
function sliceFunction(lines, name) {
  const start = lines.findIndex((line) => new RegExp(`^\\s*function ${name}\\s*\\(`).test(line));
  if (start < 0) throw new Error(`在 HTML 里找不到 ${name}`);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(function |async function |\/\/ =====)/.test(lines[i])) {
      return lines.slice(start, i).join("\n").replace(/\s+$/, "");
    }
  }
  throw new Error(`${name} 没有找到结束位置`);
}

const source = await resolveSource(process.argv);
const lines = (await readFile(source, "utf8")).split("\n");
const blocks = WANTED.map((name) => sliceFunction(lines, name));

const header = `// 从 agnes-playground.html 原样搬过来的三段系统提示词（导演 / 运动导演 / 评委）。
//
// 刻意逐字保留，不做任何改写：这三段是调出来的，任何措辞改动都会改变模型行为。
// 上游那份 HTML 若有更新，用 tools/sync-agnes-prompts.mjs 重新同步，不要手改。
//
// 来源：${path.basename(source)}

`;

const target = path.join(ROOT, "src/agnes-prompts.mjs");
await writeFile(target, `${header}${blocks.join("\n\n")}\n\nexport { ${WANTED.join(", ")} };\n`, "utf8");

const { SKILL_DIRECTOR, SKILL_MOTION, SKILL_JUDGE } = await import(`${target}?t=${Date.now()}`);
console.log(`已同步 ${target}`);
console.log(`  SKILL_DIRECTOR(6) ${SKILL_DIRECTOR(6).length} 字`);
console.log(`  SKILL_MOTION()    ${SKILL_MOTION().length} 字`);
console.log(`  SKILL_JUDGE(6)    ${SKILL_JUDGE(6).length} 字`);
