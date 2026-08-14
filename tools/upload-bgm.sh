#!/usr/bin/env bash
#
# 把本机的背景音库传到 mingxiang2-bgm 的 Release 附件里。
#
# 为什么不 git track：180 个 mp3 合计 1.1GB，git track 的话每次 clone 都要拉一遍，
# 而且进了历史就删不掉。Release 附件不算 git 对象，主仓库的 workflow 每次只下载
# **随机挑中的那一个**（3~11MB），不是整个库。
#
# 为什么改成序号名：GitHub 会把附件名里的空格换成点，逗号之类的也可能被处理，
# 而这批里有 20 个名字带逗号。与其下载时去猜它变成了什么，不如上传时就统一成
# bgm-001.mp3 这种确定的名字，原名另存进 manifest.json 备查
# （成品清单里要能看出这一集用的是哪首）。
#
# 用法：
#   bash tools/upload-bgm.sh              # 预演
#   bash tools/upload-bgm.sh --apply      # 真的传
set -euo pipefail

SRC="${BGM_SRC:-$HOME/Desktop/背景音}"
REPO="${BGM_REPO:-zhenghehao/mingxiang2-bgm}"
TAG="${BGM_TAG:-bgm-v1}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

command -v gh >/dev/null || { echo "需要 gh CLI"; exit 1; }
[ -d "$SRC" ] || { echo "找不到背景音目录：$SRC"; exit 1; }

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

MANIFEST="$STAGE/manifest.json"
echo '{' > "$MANIFEST"
echo '  "tag": "'"$TAG"'",' >> "$MANIFEST"
echo '  "_说明": "序号名 → 原始文件名。上传时改名是因为 GitHub 会处理附件名里的空格和逗号；下载按序号取，不靠猜。",' >> "$MANIFEST"
echo '  "tracks": {' >> "$MANIFEST"

i=0
total=0
while IFS= read -r f; do
  i=$((i + 1))
  name=$(printf 'bgm-%03d.mp3' "$i")
  # 硬链接优先：1.1GB 复制一遍纯属浪费。跨卷时 ln 会失败，退回复制。
  ln "$f" "$STAGE/$name" 2>/dev/null || cp "$f" "$STAGE/$name"
  orig=$(basename "$f")
  esc=$(printf '%s' "$orig" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  [ "$i" -gt 1 ] && printf ',\n' >> "$MANIFEST"
  printf '    "%s": %s' "$name" "$esc" >> "$MANIFEST"
  total=$((total + $(du -k "$f" | cut -f1)))
done < <(find "$SRC" -type f -name '*.mp3' | sort)

printf '\n  }\n}\n' >> "$MANIFEST"

echo "源目录：$SRC"
echo "目标：  $REPO  release $TAG"
echo "文件：  $i 个，合计 $((total / 1024)) MB"
[ "$APPLY" = "1" ] && echo "模式：  真的上传" || echo "模式：  预演"
echo
python3 -c "import json;d=json.load(open('$MANIFEST'));print('  对照表校验：', len(d['tracks']), '条，JSON 合法')"
echo "  前三条："
python3 -c "
import json
d=json.load(open('$MANIFEST'))
for k in list(d['tracks'])[:3]: print(f'    {k}  ←  {d[\"tracks\"][k]}')
"

if [ "$APPLY" != "1" ]; then
  echo
  echo "以上是预演。确认后：bash tools/upload-bgm.sh --apply"
  exit 0
fi

echo
gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
  && echo "release $TAG 已存在，往里追加" \
  || gh release create "$TAG" --repo "$REPO" --title "背景音库 $TAG" \
       --notes "180 首背景音。附件名是序号，原名见 manifest.json。主仓库 workflow 每次随机取一首。"

# 一个个传：一次性把 180 个参数塞给 gh 容易撞命令行长度上限，
# 而且中途失败时看不出断在哪一个。--clobber 让重跑可以覆盖已传的。
ok=0; fail=0
gh release upload "$TAG" --repo "$REPO" --clobber "$MANIFEST" >/dev/null 2>&1 && echo "  manifest.json ✓"
for n in $(seq 1 "$i"); do
  name=$(printf 'bgm-%03d.mp3' "$n")
  if gh release upload "$TAG" --repo "$REPO" --clobber "$STAGE/$name" >/dev/null 2>&1; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1)); echo "  ✗ $name"
  fi
  [ $((n % 20)) -eq 0 ] && echo "  …已传 $n/$i"
done
echo
echo "上传完成：成功 $ok，失败 $fail"
[ "$fail" -gt 0 ] && exit 1 || true
