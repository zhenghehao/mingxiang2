#!/usr/bin/env bash
#
# 把本机已经配好的密钥同步到 GitHub Actions Secrets。
#
# 为什么要有这个：secret 有 8 个，其中几个是上百把 key 用逗号连起来的长串，
# 手动粘贴既累又容易漏一把、或者不小心带上换行（带换行的那把会整条失效，
# 而且报错时看不出是哪里错了）。这些值本来就都在本机：
#   data/config.json  —— Agnes 和 SenseNova 的 key（这个文件在 .gitignore 里）
#   macOS 钥匙串      —— 文本引擎和 MiniMax 的 key
# 直接从源头读、从源头灌，中间不落地、不打印。
#
# 三条刻意的做法：
#   1. 值一律走 stdin 交给 gh（--body-file -），不进命令行参数 ——
#      argv 会出现在 ps 输出和 shell 历史里。
#   2. 全程只打印「多少把」「多少字符」，绝不打印值本身。
#   3. 默认只预演（列出会设哪些、不真的设），加 --apply 才动手。
#
# 用法：
#   bash tools/push-secrets.sh              # 预演，看看会设哪些
#   bash tools/push-secrets.sh --apply      # 真的设进去
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="${GITHUB_REPO:-zhenghehao/mingxiang2}"
APPLY=0
FAILED=0
[ "${1:-}" = "--apply" ] && APPLY=1

command -v gh >/dev/null || { echo "需要 gh CLI：brew install gh && gh auth login"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 未登录：gh auth login"; exit 1; }
[ -f data/config.json ] || { echo "找不到 data/config.json"; exit 1; }

# 从 config.json 取某个 key 数组，逗号连接后从 stdout 交出去。
# 用 node 而不是 jq：仓库本来就依赖 node，少一个外部依赖。
read_keys() {
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync("data/config.json", "utf8"));
    const a = c.agnesHeadless || {};
    const list = (a[process.argv[1]] || []).map(k => String(k || "").trim()).filter(Boolean);
    process.stdout.write([...new Set(list)].join(","));
  ' "$1"
}

# 钥匙串里的两把。找不到就返回空，由调用方跳过。
read_keychain() {
  /usr/bin/security find-generic-password -s com.shareit.sleepflow-studio -a "$1" -w 2>/dev/null || true
}

set_secret() {
  local name="$1" value="$2" desc="$3"
  if [ -z "$value" ]; then
    printf '  %-28s 跳过（本机没有）\n' "$name"
    return
  fi
  local n=$(printf '%s' "$value" | tr ',' '\n' | grep -c . || true)
  printf '  %-28s %3d 把 / %5d 字符  %s\n' "$name" "$n" "${#value}" "$desc"
  if [ "$APPLY" = "1" ]; then
    # 不传 --body：gh 在没给它时就从标准输入读，值因此不进 argv
    # （argv 会出现在 ps 输出和 shell 历史里）。
    # 也别用 --body-file -，老一点的 gh 没有这个 flag，实测 2.x 上直接 unknown flag。
    # printf '%s' 而不是 echo：echo 会补一个换行，那个换行会被当成 key 的一部分。
    if printf '%s' "$value" | gh secret set "$name" --repo "$REPO" >/dev/null 2>&1; then
      printf '  %-28s ✓ 已写入\n' ""
    else
      printf '  %-28s ✗ 写入失败\n' ""
      FAILED=1
    fi
  fi
}

echo "仓库：$REPO"
[ "$APPLY" = "1" ] && echo "模式：真的写入" || echo "模式：预演（加 --apply 才真的写）"
echo

DIRECTOR=$(read_keys directorKeys)
MOTION=$(read_keys motionKeys)
SCORER=$(read_keys scorerKeys)
AGNES=$(read_keys apiKeys)

set_secret AGNES_API_KEYS          "$AGNES"    "生图 + 生视频"
set_secret SENSENOVA_DIRECTOR_KEYS "$DIRECTOR" "导演：文稿→场景提示词"
set_secret SENSENOVA_MOTION_KEYS   "$MOTION"   "运动导演：看图写运动词"
set_secret SENSENOVA_SCORER_KEYS   "$SCORER"   "评委已删，仅作 DIRECTOR 兜底"
# 封面走的也是 SenseNova，同一个端点。cover.mjs 现在会回退到配置里那批，
# 但云端没有 config.json，所以这个 secret 必须单独设。
set_secret SENSENOVA_API_KEYS      "$DIRECTOR" "封面（和导演同一批）"
set_secret TEXT_API_KEY            "$(read_keychain text-provider-api-key)" "写稿 + 发布文案"
set_secret MINIMAX_API_KEY         "$(read_keychain minimax-api-key)"       "配音（按量）"
set_secret MINIMAX_SUBSCRIPTION_KEY "$(read_keychain minimax-subscription-key)" "配音（订阅，可空）"

echo
if [ "$APPLY" = "1" ] && [ "$FAILED" = "1" ]; then
  echo "有 secret 没写成功，上面标了 ✗。先解决再往下走。"
  exit 1
fi
if [ "$APPLY" = "1" ]; then
  echo "写完了。建议接着跑一次体检确认云端真的能用："
  echo "  gh workflow run preflight.yml --repo $REPO"
else
  echo "以上只是预演。确认无误后："
  echo "  bash tools/push-secrets.sh --apply"
fi
