#!/usr/bin/env bash
# 一键同步：子模块（插件）→ 主仓库。
#
# 用法：
#   ./sync.sh "提交说明"              只处理有改动的子模块
#   ./sync.sh "提交说明" dsh-forge    只处理指定子模块
#
# 顺序是有讲究的：
#   1. 主仓库先 pull，保证和远端一致
#   2. 每个子模块 pull --rebase（带 autostash）→ add -A → commit → push
#   3. 回到主仓库，记录新的 submodule 指针 → commit → push
#
# 只推子模块不推主仓库 = 更新没落地：clone 主仓库的人拿到的是旧指针。
set -uo pipefail

MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "用法: ./sync.sh \"提交说明\" [子模块目录...]" >&2
  exit 2
fi
shift || true

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

if [ ! -f .gitmodules ]; then
  echo "✗ $ROOT 不是主仓库（找不到 .gitmodules）" >&2
  exit 2
fi

sub_paths() {
  git config --file .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $2}'
}

SUB_LIST="$(sub_paths | tr '\n' ' ')"

SUBS=()
if [ "$#" -gt 0 ]; then
  SUBS=("$@")
else
  while IFS= read -r sub; do
    [ -n "$sub" ] || continue
    [ -d "$sub" ] || continue
    if [ -n "$(git -C "$sub" status --porcelain 2>/dev/null)" ]; then
      SUBS+=("$sub")
    fi
  done < <(sub_paths)
fi

echo "主仓库: $ROOT"
if ! git pull --rebase --autostash --quiet; then
  echo "✗ 主仓库 pull 失败（先手动处理冲突/未提交改动）" >&2
  exit 1
fi

if [ "${#SUBS[@]}" -eq 0 ]; then
  echo "没有要提交的子模块改动"
else
  for sub in "${SUBS[@]}"; do
    echo "── $sub"
    if [ ! -d "$sub" ]; then
      echo "  ✗ 目录不存在，跳过" >&2
      continue
    fi
    if ! git -C "$sub" pull --rebase --autostash --quiet; then
      echo "  ✗ pull 失败，停在这里（后面的子模块和主仓库都没动）" >&2
      exit 1
    fi
    if [ -n "$(git -C "$sub" status --porcelain)" ]; then
      git -C "$sub" add -A || exit 1
      git -C "$sub" commit -q -m "$MSG" || exit 1
      echo "  提交 $(git -C "$sub" rev-parse --short HEAD) $(git -C "$sub" log -1 --pretty=%s)"
    else
      echo "  没有改动"
    fi
    if ! git -C "$sub" push --quiet origin HEAD; then
      echo "  ✗ push 失败（先 git -C $sub pull --rebase 再重试）" >&2
      exit 1
    fi
    echo "  已推送 $(git -C "$sub" rev-parse --abbrev-ref HEAD)"
  done
fi

# 主仓库：把所有已变化的子模块指针一起记下来（包括被别人 pull 前进的）
while IFS= read -r sub; do
  [ -n "$sub" ] || continue
  [ -d "$sub" ] || continue
  git add -- "$sub" 2>/dev/null
done < <(sub_paths)

if git diff --cached --quiet; then
  echo "主仓库指针没有变化"
else
  git commit -q -m "chore: 同步子模块指针（${SUBS[*]:-无改动}）" || exit 1
  if ! git push --quiet origin HEAD; then
    echo "✗ 主仓库 push 失败" >&2
    exit 1
  fi
  echo "主仓库已推送 $(git rev-parse --short HEAD)"
fi

# 主仓库里子模块之外的改动：脚本不替你判断该不该提交，只提示
OTHER="$(git status --porcelain | awk -v subs="$SUB_LIST" '
  BEGIN { n = split(subs, a, " ") }
  { path = $2; keep = 1; for (i = 1; i <= n; i++) if (path == a[i]) keep = 0; if (keep) print }
')"
if [ -n "$OTHER" ]; then
  echo
  echo "⚠ 主仓库还有子模块之外的改动（没替你提交）："
  printf '%s\n' "$OTHER" | sed 's/^/    /'
fi

echo
echo "状态："
for sub in $(sub_paths); do
  [ -d "$sub" ] || continue
  printf '  %-22s %s\n' "$sub" "$(git -C "$sub" status -sb | head -1)"
done
printf '  %-22s %s\n' "（主仓库）" "$(git status -sb | head -1)"
