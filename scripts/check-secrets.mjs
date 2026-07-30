#!/usr/bin/env node
/**
 * 体检：环境变量里的密钥到底长什么样、能不能用。
 *
 * CI 上 401 时最难判断的是「secret 填错了」还是「服务端拒绝这个来源」。
 * 密钥本身不能打印，但**长度、数量、首尾各 4 位**足以认出是不是同一批，
 * 又不至于泄露。再对每批做一次最小请求，把 HTTP 状态摊开。
 */
const GROUPS = [
  ["TEXT_API_KEY", "https://api.deepseek.com/chat/completions", "deepseek-v4-flash"],
  ["SENSENOVA_API_KEYS", "https://token.sensenova.cn/v1/chat/completions", "sensenova-6.7-flash-lite"],
  ["SENSENOVA_SCORER_KEYS", "https://token.sensenova.cn/v1/chat/completions", "sensenova-6.7-flash-lite"],
  ["SENSENOVA_MOTION_KEYS", "https://token.sensenova.cn/v1/chat/completions", "sensenova-6.7-flash-lite"],
  ["AGNES_API_KEYS", "https://api.agnes-ai.cn/v1/chat/completions", "agnes-2.5-flash"],
  // 备选入口：另一批令牌、另一代模型。CI 上官方直连 401 时，
  // 用它判断是「这批 key 不行」还是「Agnes 整体不收这个来源」——
  // 两个端点都 401 就是后者，换端点也没用。
  ["AGNES_HUB_KEYS", "https://apihub.agnes-ai.cn/v1/chat/completions", "agnes-2.0-flash"]
];

const split = (raw) => [...new Set(String(raw || "").split(/[,、，;；\s]+/).map((s) => s.trim()).filter(Boolean))];
const mask = (k) => `${k.slice(0, 6)}…${k.slice(-4)}(${k.length}位)`;

for (const [name, url, model] of GROUPS) {
  const keys = split(process.env[name]);
  if (!keys.length) { console.log(`✗ ${name}  没设`); continue; }
  console.log(`${name}  ${keys.length} 把：${keys.map(mask).join("  ")}`);
  for (const [i, key] of keys.entries()) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 4 }),
        signal: AbortSignal.timeout(45000)
      });
      let msg = ""; try { msg = JSON.parse(await r.text()).error?.message || ""; } catch {}
      console.log(`   ${r.ok ? "✓" : "✗"} #${i + 1} HTTP ${r.status} ${msg.slice(0, 60)}`);
    } catch (e) { console.log(`   ✗ #${i + 1} ${e.message}`); }
  }
}
console.log("\n出口 IP（用来判断是不是被按地区拦了）：");
try {
  const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(15000) });
  console.log("  ", (await r.json()).ip);
} catch (e) { console.log("  查不到：", e.message); }

console.log("\nMINIMAX_SUBSCRIPTION_KEY:", process.env.MINIMAX_SUBSCRIPTION_KEY
  ? mask(process.env.MINIMAX_SUBSCRIPTION_KEY) : "没设");
