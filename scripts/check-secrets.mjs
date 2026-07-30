#!/usr/bin/env node
/**
 * 体检：环境变量里的密钥到底长什么样、能不能用。
 *
 * CI 上 401 时最难判断的是「secret 填错了」还是「服务端拒绝这个来源」。
 * 密钥本身不能打印，但**长度、数量、首尾各 4 位**足以认出是不是同一批，
 * 又不至于泄露。再对每批做一次最小请求，把 HTTP 状态摊开。
 */
// Agnes 的端点和模型名从应用真正读的那份配置里取：default-config ← 环境变量。
// 不在这里写死 —— 体检必须打和应用完全相同的端点和模型，否则换端点后
// 两边一漂移，体检结果就变成假信号，比不体检更糟。
const { readFile } = await import("node:fs/promises");
const dflt = JSON.parse(await readFile(new URL("../data/default-config.json", import.meta.url), "utf8"));
const agnesBase = process.env.AGNES_BASE_URL || dflt.agnesHeadless?.baseUrl || "https://apihub.agnes-ai.cn";
const agnesModel = process.env.AGNES_TEXT_MODEL || dflt.agnesHeadless?.textModel || "agnes-2.0-flash";

const GROUPS = [
  ["TEXT_API_KEY", "https://api.deepseek.com/chat/completions", "deepseek-v4-flash"],
  ["SENSENOVA_API_KEYS", "https://token.sensenova.cn/v1/chat/completions", "sensenova-6.7-flash-lite"],
  ["SENSENOVA_SCORER_KEYS", "https://token.sensenova.cn/v1/chat/completions", "sensenova-6.7-flash-lite"],
  ["SENSENOVA_MOTION_KEYS", "https://token.sensenova.cn/v1/chat/completions", "sensenova-6.7-flash-lite"],
  ["AGNES_API_KEYS", `${agnesBase}/v1/chat/completions`, agnesModel]
];

const split = (raw) => [...new Set(String(raw || "").split(/[,、，;；\s]+/).map((s) => s.trim()).filter(Boolean))];
const mask = (k) => `${k.slice(0, 6)}…${k.slice(-4)}(${k.length}位)`;

console.log(`Agnes 端点 ${agnesBase} · 模型 ${agnesModel}（跟随 default-config，可用环境变量覆盖）\n`);

// 记账。CI 上必须靠退出码把结论传出去 —— 只在日志里打 ✗ 而进程 exit 0，
// workflow 会是绿的，等于告诉你「密钥没问题」，那比不体检更糟。
const missing = [];
const failed = [];

for (const [name, url, model] of GROUPS) {
  const keys = split(process.env[name]);
  if (!keys.length) { console.log(`✗ ${name}  没设`); missing.push(name); continue; }
  console.log(`${name}  ${keys.length} 把：${keys.map(mask).join("  ")}`);
  for (const [i, key] of keys.entries()) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
        // 15 秒足够判断鉴权。原来 45 秒会让几把坏 key 把整轮体检拖成好几分钟，
        // 而体检的价值就在于快 —— 慢到要等，就不会有人在正式跑之前先跑它。
        signal: AbortSignal.timeout(15000)
      });
      let msg = ""; try { msg = JSON.parse(await r.text()).error?.message || ""; } catch {}
      console.log(`   ${r.ok ? "✓" : "✗"} #${i + 1} HTTP ${r.status} ${msg.slice(0, 60)}`);
      if (!r.ok) failed.push(`${name}#${i + 1} HTTP ${r.status}`);
    } catch (e) {
      console.log(`   ✗ #${i + 1} ${e.message}`);
      failed.push(`${name}#${i + 1} ${e.message}`);
    }
  }
}
console.log("\n出口 IP（用来判断是不是被按地区拦了）：");
try {
  const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(15000) });
  console.log("  ", (await r.json()).ip);
} catch (e) { console.log("  查不到：", e.message); }

// MiniMax 只看有没有，不发试探请求 —— t2a 那个接口一调就真的合成音频、真的计费，
// 为体检花这个钱不值得。所以它缺失只提醒，不算失败。
const minimaxSet = Boolean(process.env.MINIMAX_SUBSCRIPTION_KEY);
console.log("\nMINIMAX_SUBSCRIPTION_KEY:", minimaxSet
  ? `${mask(process.env.MINIMAX_SUBSCRIPTION_KEY)}（只验证存在，没发请求：调一次就会真的合成并计费）`
  : "没设 —— 人声那一步会直接失败");

console.log("\n" + "=".repeat(56));
if (missing.length) console.log(`没设：${missing.join("、")}`);
if (failed.length) console.log(`调不通：${failed.join("、")}`);
if (!minimaxSet) console.log("没设：MINIMAX_SUBSCRIPTION_KEY");

if (missing.length || failed.length || !minimaxSet) {
  console.log("\n体检未通过。上面每一条都会让正式跑在对应的步骤上失败，先修再跑。");
  // 退出码 1 → workflow 变红。绿勾必须真的代表「可以跑了」。
  process.exit(1);
}
console.log("\n全部通过，可以跑正式生成。");
