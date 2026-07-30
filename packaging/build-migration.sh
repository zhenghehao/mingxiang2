#!/bin/zsh
#
# 打一个能搬到另一台 Mac 的整套工作流。
#
# 这是**自用**迁移包：用户明确要求把密钥和登录态一起带走，省得在新机器上
# 一个个重填。所以包里有你全部的 API 密钥和平台 cookie。
#
#   >>> 这个 zip 等同于你的账号本身，只能在你自己两台 Mac 之间走。
#   >>> 不要发给别人、不要传网盘、不要放进任何 git 仓库。
#
# 名字里带「含密钥」就是为了让它在文件夹里一眼能认出来 —— 旧脚本把同样含密钥的
# 包命名成「无密码」（意思是解压不用密码），太容易被当成不敏感的东西转手。
#
# 带上两个配套服务：Agnes（出画面）和最终发布（发平台）。少任何一个，
# 这条流水线在新机器上都只能跑一半。
#
# 用法：
#   zsh packaging/build-migration.sh              # 含密钥（默认）
#   zsh packaging/build-migration.sh --no-secrets # 不含密钥，可以给别人
#
# 产物：项目目录下的 迁移包-YYYYMMDD-含密钥/ 和同名 .zip

set -euo pipefail
umask 077

project_root="$(cd "$(dirname "$0")/.." && pwd)"
agnes_src="/Users/shareit/Desktop/agnes-playground"
publisher_src="/Users/shareit/Desktop/最终发布"
bgm_src="/Users/shareit/Desktop/未命名文件夹 6/未命名文件夹 2"
video_src="/Users/shareit/Desktop/未命名文件夹 6/未命名文件夹 4"

with_secrets=1
[[ "${1:-}" == "--no-secrets" ]] && with_secrets=0

date_tag="$(/bin/date +%Y%m%d)"
if (( with_secrets )); then
  stage_name="迁移包-${date_tag}-含密钥"
else
  stage_name="迁移包-${date_tag}-不含密钥"
fi
stage="$project_root/$stage_name"
zip_path="$project_root/${stage_name}.zip"

/bin/rm -rf "$stage" "$zip_path"
/bin/mkdir -p "$stage"

say() { print -r -- "  $1"; }

# ---------------------------------------------------------------- 主项目
say "打包 冥想一键工作流"
/bin/mkdir -p "$stage/冥想一键工作流"
/usr/bin/rsync -a \
  --exclude '.git' \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude 'work/runs' \
  --exclude 'outputs' \
  --exclude '迁移包-*' \
  $( (( with_secrets )) || print -- --exclude 'data/config.json' ) \
  --exclude 'data/asset-history.json' \
  "$project_root/" "$stage/冥想一键工作流/"

# node_modules 不打包：ffmpeg-static / ffprobe-static 在 postinstall 时按 CPU 架构
# 下载对应的二进制。把 Intel 机器上的 node_modules 拷到 Apple Silicon（或反过来）
# 会得到一个跑不起来的 ffmpeg，而且报错很难懂。新机器上跑一次 npm install 就好。

if (( ! with_secrets )); then
  # 只有「给别人」的包才抹掉 src/cover.mjs 里写死的商汤 key
  /usr/bin/sed -i '' \
    's/|| "sk-[A-Za-z0-9]*"/|| ""  \/* 迁移包已清空，请设 SENSENOVA_API_KEY 环境变量 *\//' \
    "$stage/冥想一键工作流/src/cover.mjs"
fi

# ---------------------------------------------------------------- Agnes
if [[ -d "$agnes_src" ]]; then
  say "打包 Agnes 视觉工作台"
  /bin/mkdir -p "$stage/agnes-playground"
  /usr/bin/rsync -a \
    --exclude '.git' --exclude '.DS_Store' \
    --exclude 'node_modules' \
    --exclude 'output' \
    "$agnes_src/" "$stage/agnes-playground/"
  /bin/mkdir -p "$stage/agnes-playground/output"
  if (( ! with_secrets )); then
    # agnes-playground.html 里内联着一串轮换用的模型密钥（十几个 sk-…）。
    # 只有「给别人」的包才抹掉；自用包保留，否则新机器上还得一个个填回去。
    /usr/bin/find "$stage/agnes-playground" -type f \( -name '*.html' -o -name '*.js' \) \
      -exec /usr/bin/sed -i '' -E 's/sk-[A-Za-z0-9]{16,}/在这里填你自己的密钥/g' {} +
  fi
else
  say "跳过 Agnes（$agnes_src 不存在）"
fi

# ---------------------------------------------------------------- 发布服务
if [[ -d "$publisher_src" ]]; then
  say "打包 最终发布$( (( with_secrets )) && print -n '（含平台登录态）' || print -n '（不含登录态）')"
  /bin/mkdir -p "$stage/最终发布"
  # .venv/.venv311 永远不带：Python 虚拟环境里全是写死的绝对路径和按架构编译的
  # 二进制，换台机器必然跑不起来，新机器上重建一次反而快。
  # .publisher_data 自用包带上，但注意里面**没有**平台登录态：发布走 CDP 连真实
  # Chrome，会话存在 Chrome 的用户资料里，cookies/ 目录是空的，只有任务记录 data.db。
  # 换机器后平台还是得重新扫码，这一步没法打包免掉。
  /usr/bin/rsync -a \
    --exclude '.git' --exclude '.DS_Store' \
    --exclude '.venv' --exclude '.venv311' \
    --exclude '__pycache__' \
    $( (( with_secrets )) || print -- --exclude '.publisher_data' ) \
    "$publisher_src/" "$stage/最终发布/"
else
  say "跳过 最终发布（$publisher_src 不存在）"
fi

# ---------------------------------------------------------------- 素材与 Skills
say "打包 背景音乐与视频素材"
/bin/mkdir -p "$stage/素材/bgm" "$stage/素材/video"
[[ -d "$bgm_src" ]]   && /usr/bin/rsync -a "$bgm_src/"   "$stage/素材/bgm/"
[[ -d "$video_src" ]] && /usr/bin/rsync -a "$video_src/" "$stage/素材/video/"

say "打包 Skills"
/bin/mkdir -p "$stage/skills"
copy_skill() {  # $1=源文件 $2=目标子目录名
  if [[ -f "$1" ]]; then
    /bin/mkdir -p "$stage/skills/$2"
    /bin/cp "$1" "$stage/skills/$2/SKILL.md"
  else
    say "  ! 找不到 Skill：$1"
  fi
}
copy_skill "/Users/shareit/Desktop/未命名文件夹/助眠选题器-SKILL 2.md" "01-topic"
copy_skill "/Users/shareit/Desktop/未命名文件夹/催眠入睡文稿写作引擎-SKILL-v2.1 2.md" "02-script"
copy_skill "/Users/shareit/Desktop/眠屿四个Skills/minimax-meditation-tts-ultimate-v3/SKILL.md" "03-minimax-tts"
copy_skill "/Users/shareit/.codex/skills/sleep-content-publisher-copywriter/SKILL.md" "04-publisher-copywriter"

# ---------------------------------------------------------------- 密钥
if (( with_secrets )); then
  say "导出钥匙串密钥（系统会弹窗要你授权，每个一次）"
  secrets_dir="$stage/密钥-不要外传"
  /bin/mkdir -p "$secrets_dir"
  /bin/chmod 700 "$secrets_dir"

  # 主程序的三把钥匙存在 macOS 钥匙串里（service = com.shareit.sleepflow-studio，
  # 见 src/secrets.mjs）。security 读私有项会弹系统授权框，这是 macOS 的要求，
  # 也是你本人同意导出的凭证 —— 别想办法绕过它。
  for account in minimax-subscription-key minimax-api-key text-provider-api-key; do
    if /usr/bin/security find-generic-password \
         -s com.shareit.sleepflow-studio -a "$account" -w \
         > "$secrets_dir/$account.txt" 2>/dev/null; then
      say "  ✓ $account"
    else
      /bin/rm -f "$secrets_dir/$account.txt"
      say "  ! $account 没读到（可能还没配过，新机器上补填即可）"
    fi
  done

  # Codex CLI 的登录态（用 codex-cli 模式写文稿时要）
  for credential in "$HOME/.codex/auth.json" "$HOME/.codex/config.toml"; do
    [[ -f "$credential" ]] && /bin/cp "$credential" "$secrets_dir/$(/usr/bin/basename "$credential")"
  done

  /bin/chmod 600 "$secrets_dir"/* 2>/dev/null || true
  /bin/cp "$project_root/packaging/密钥怎么装回去.md" "$secrets_dir/怎么装回去.md"
fi

# ---------------------------------------------------------------- 安装说明
/bin/cp "$project_root/packaging/迁移到新Mac.md" "$stage/请先看我.md"

# ---------------------------------------------------------------- 兜底自检
# 含密钥的包：把敏感内容点出来，让你清楚这个 zip 有多敏感。
# 不含密钥的包：发现任何疑似密钥就中止 —— 那种包是要给别人的，漏一个都不行。
say "扫描包里的敏感内容"
sensitive="$(/usr/bin/grep -rIl -E 'sk-[A-Za-z0-9]{16,}|"api_?key"\s*:\s*"[^"]{16,}' "$stage" 2>/dev/null || true)"
if (( with_secrets )); then
  print -r -- ""
  print -r -- "  这个包里有你的密钥，出现在："
  [[ -n "$sensitive" ]] && print -r -- "$sensitive" | /usr/bin/sed 's|^|    |'
  [[ -d "$secrets_dir" ]] && print -r -- "    $secrets_dir/（钥匙串导出）"
  [[ -d "$stage/最终发布/.publisher_data" ]] && print -r -- "    $stage/最终发布/.publisher_data/（发布任务记录；平台会话不在这里，见说明第 5 步）"
  print -r -- ""
elif [[ -n "$sensitive" ]]; then
  print -r -- "!! --no-secrets 的包里还有疑似密钥，已中止，请检查："
  print -r -- "$sensitive"
  exit 1
fi

# ---------------------------------------------------------------- 压缩
say "压缩"
cd "$project_root"
/usr/bin/zip -qry "$zip_path" "$stage_name"
/usr/bin/shasum -a 256 "${stage_name}.zip" > "${stage_name}.zip.sha256"

print -r -- ""
print -r -- "完成："
print -r -- "  $stage"
print -r -- "  $zip_path"
print -r -- "  ${zip_path}.sha256"
/usr/bin/du -sh "$zip_path"
