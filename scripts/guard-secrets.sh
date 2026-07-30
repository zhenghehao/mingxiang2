#!/bin/zsh
# 提交前的真门闸：扫暂存内容**和** commit message，命中就非零退出。
#
# 为什么要有这个文件：之前那道检查是 `grep ... && echo "中止" || echo "干净"`，
# 它只会打印「中止」，根本不会阻止任何东西 —— 结果检测到了口令还是推了上去。
# 一个只会报告、不会拦截的检查，比没有检查更危险，因为它给人虚假的安心。
#
# 用法：
#   zsh scripts/guard-secrets.sh                     # 只扫暂存区
#   zsh scripts/guard-secrets.sh path/to/msg.txt     # 连 commit message 一起扫
set -u

# 两个清单分开，因为它们能不能被打印是不同的。
# SHAPES 是正则，打出来无害，还能告诉你命中了哪一类。
SHAPES=(
  'gh[pousr]_[A-Za-z0-9]{30,}:GitHub token'
  'sk-[A-Za-z0-9_-]{25,}:OpenAI 式密钥'
  'eyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{20,}:JWT'
  'AKIA[A-Z0-9]{16}:AWS 密钥'
)

# LITERALS 是 .env.local 里的**真值**（口令、token 本体）。它们是最容易被顺手
# 写进注释或提交说明的东西，所以必须扫；但**绝不能回显** —— 否则这道门闸自己
# 就成了泄露渠道，把新口令打进终端和 CI 日志。只报「哪个变量」，不报值。
LITERAL_VALUES=()
LITERAL_NAMES=()
ENV_LOCAL="web-console/.env.local"
if [[ -f "$ENV_LOCAL" ]]; then
  while IFS='=' read -r key val; do
    [[ "$key" == \#* || -z "${val:-}" ]] && continue
    val="${val%%[[:space:]]}"
    # 太短的值容易误伤（比如 owner/repo），只把足够长的当机密
    if [[ ${#val} -ge 8 && "$val" != REPLACE_ME* ]]; then
      LITERAL_VALUES+=("$(printf '%s' "$val" | sed 's/[.[\*^$()+?{|]/\\&/g')")
      LITERAL_NAMES+=("$key")
    fi
  done < "$ENV_LOCAL"
fi

fail=0
scan() {
  local label="$1" text="$2" i
  for entry in "${SHAPES[@]}"; do
    local rx="${entry%%:*}" name="${entry##*:}"
    if printf '%s' "$text" | grep -qE "$rx" 2>/dev/null; then
      print -r -- "  ✗ ${label} 命中：${name}"
      fail=1
    fi
  done
  for i in {1..${#LITERAL_VALUES[@]}}; do
    (( ${#LITERAL_VALUES[@]} == 0 )) && break
    if printf '%s' "$text" | grep -qE "${LITERAL_VALUES[$i]}" 2>/dev/null; then
      # 只说变量名，不说值
      print -r -- "  ✗ ${label} 里出现了 ${LITERAL_NAMES[$i]} 的真实值"
      fail=1
    fi
  done
}

scan "暂存内容" "$(git diff --cached)"
[[ $# -ge 1 && -f "$1" ]] && scan "commit message" "$(cat "$1")"

if (( fail )); then
  print -r -- ""
  print -r -- "已阻止提交。密钥、口令的真值不要出现在代码注释或提交说明里 ——"
  print -r -- "解释问题用「带尾部换行的值」这类描述就够，不需要真值。"
  exit 1
fi
print -r -- "  ✓ 暂存内容与提交说明均无敏感串"
