#!/usr/bin/env bash
# 每日同步：有本地改动就提交并推送，远程有新提交就先 rebase 拉取再推送。
# 用法：bash tools/sync.sh
# 退出码：0 = 成功（含无变动）；1 = 网络/配置/推送失败；2 = rebase 冲突（已 abort，需人工处理）
set -u

cd "$(dirname "$0")/.." || exit 1

say() { printf '%s\n' "$*"; }
now() { date '+%Y-%m-%d %H:%M:%S'; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  say "ERROR: 当前目录不是 git 仓库"; exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  say "ERROR: 未配置 origin 远程仓库"; exit 1
fi

branch=$(git rev-parse --abbrev-ref HEAD)
upstream="origin/$branch"

say "[$(now)] 开始同步（分支: $branch）"

# 1) 拉取远程引用（只 fetch，不动工作区）
if ! git fetch --prune origin 2>&1; then
  say "ERROR: git fetch 失败（网络或 SSH 密钥问题）"; exit 1
fi

have_upstream=0
if git rev-parse --verify -q "$upstream" >/dev/null; then
  have_upstream=1
fi

# 2) 本地有改动 → 提交
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  say "检测到本地改动，正在提交…"
  git add -A
  if ! git commit -q -m "auto: 同步本地改动 $(now)"; then
    say "ERROR: git commit 失败"; exit 1
  fi
  say "已提交: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
else
  say "本地无未提交改动"
fi

# 3) 远程有新提交 → rebase 拉取
if [ "$have_upstream" = 1 ]; then
  behind=$(git rev-list --count "HEAD..$upstream" 2>/dev/null || echo 0)
  if [ "$behind" -gt 0 ]; then
    say "远程有 $behind 个新提交，执行 rebase 拉取…"
    if ! git pull --rebase --autostash origin "$branch" 2>&1; then
      say "ERROR: rebase 发生冲突，已尝试回滚到同步前状态，需人工处理"
      git rebase --abort >/dev/null 2>&1
      exit 2
    fi
    say "拉取完成，当前 HEAD: $(git rev-parse --short HEAD)"
  else
    say "远程无新提交"
  fi
fi

# 4) 本地领先远程 → 推送
if [ "$have_upstream" = 1 ]; then
  ahead=$(git rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)
else
  ahead=1
fi
if [ "$ahead" -gt 0 ]; then
  say "本地领先远程 $ahead 个提交，正在推送…"
  if ! git push origin "$branch" 2>&1; then
    say "ERROR: git push 失败"; exit 1
  fi
  say "推送成功: $(git rev-parse --short HEAD) -> origin/$branch"
else
  say "无需推送：本地与远程一致"
fi

say "[$(now)] 同步结束，工作区状态："
git status -sb

# 5) 首次推送时补设 upstream
if [ "$have_upstream" = 0 ]; then
  git branch --set-upstream-to="origin/$branch" >/dev/null 2>&1
fi

exit 0
