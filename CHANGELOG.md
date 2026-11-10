# Changelog

## [0.2.0] - 2026-11-10

### 新增

- `/next panes`：列出本会话派发过的窗格（provider · 窗格 id · 当初的标题），选中即跳转。
- 派发互斥：`p` 之后到窗格拉起来之间的 select / confirm 窗口期内，重复触发会被拒绝并提示，
  不会开出两个窗格。
- `pruneHandoffs()`：`$TMPDIR/pi-next-handoff` 只保留最近 20 次派发的文件，更早的在下次派发时清掉。
- 类型检查：`tsconfig.json` + `tsc --noEmit`（strict、`noUncheckedIndexedAccess`），
  三个 `@earendil-works/*` 作为 devDependencies 装进来，类型检查才有真实的宿主 API 可对。
- CI：GitHub Actions 在 push / PR 时跑 `bun install --frozen-lockfile` → `typecheck` → `test`。

### 变更

- `bunfig.toml` 移到仓库根，`bun test` 在根目录直接可用（之前只能在 `tests/` 里跑，根目录拿不到 preload）。
- `tests/setup.ts` 改为「仓库 `node_modules` 优先、本机 pi 安装兜底」，CI 不再需要装 pi。

### 修复

- `resolvePiBin` 的测试不再假设本机存在托管 pi；CI（Linux，无 `~/.pi/agent/bin/pi`）下会退化成
  `PATH` 查找的 `pi`，原断言因此失败。

## [0.1.0] - 2026-11-10

- 从个人 `~/.pi/agent/extensions` 提炼为可分发的包。
- 多选下一步候选；回车只填编辑器，`p` 派发。
- 派发写 handoff 文件 + runner 脚本，并在**当前 tab** 新开一个窗格：Otty、tmux、zellij、
  wezterm、Ghostty（走 AppleScript `split`）。
- `/next focus [n]` 跳回已派发的窗格；成功提示带 Otty deeplink。
- runner 解析 `pi` 的绝对路径并复制 pi 自己的 `PATH`，从登录 shell 启动也不会 `pi: not found`。
