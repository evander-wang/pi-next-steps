# pi-next-steps

给 [Pi](https://pi.dev) 用的扩展：每轮回答结束后给出最多 3 条「下一步」候选。
回车只是把候选填进输入框，**永远不会自动执行**；按 `p` 才会把勾选的任意 1~N 条
交给一个**继承了当前会话上下文的独立 agent**，在**新窗格里**跑。

## 它能做什么

- 每轮结束自动生成 1~3 条具体候选（便宜模型跑，20s 超时，失败静默）
- 多选：空格勾选，回车把勾选集拼成一条消息填进输入框（你改完自己发）
- 勾 1~N 条按 `p`：选终端 → 确认 → 新窗格里起一个独立会话按清单干
- `/next panes` 列出这次会话派发过的窗格，选中即跳；`/next focus [n]` 直接跳第 n 个

## 安装

### 方式 A：从 GitHub 装（推荐）

```bash
pi install git:github.com/evander-wang/pi-next-steps
pi list          # 确认出现 git:github.com/evander-wang/pi-next-steps
/reload          # 或重启 pi
```

Pi 会把它克隆到 `~/.pi/agent/git/github.com/evander-wang/pi-next-steps`，
**这个目录是加载副本，不要直接改**。

### 方式 B：本地开发源

```bash
pi install /绝对路径/pi-next-steps     # 一定要绝对路径
```

⚠️ `pi install` 会把路径写进 `~/.pi/agent/settings.json`，**按相对于该文件的路径存**（形如
`../../src/pi-next-steps`）。所以别移动开发目录，否则要重新装。

同一时刻**只能有一份**：如果 `~/.pi/agent/extensions/` 里还躺着一个同名扩展，
两份都会加载、`/next` 会注册两次。装包前先挪走旧的那份。

### 卸载

```bash
pi remove git:github.com/evander-wang/pi-next-steps
```

`pi remove` 按当前工作目录解析相对路径，装的是本地源时**必须给绝对路径**
（`pi remove ./相对路径` 会报 `No matching package found`）。

## 更新流程

扩展分两个地方：**开发仓库**（`~/src/pi-next-steps`）和 **pi 的加载副本**
（`~/.pi/agent/git/...`）。改了开发仓库不会自动生效，走三步：

```bash
# 1. 开发侧：改代码 / 改测试
cd ~/src/pi-next-steps
bun test                       # 或 cd tests && bun test

# 2. 推上去
git add -A && git commit -m "…" && git push

# 3. 使用侧：拉新版本并重载
pi update --extensions
/reload
```

说明：

- `pi update --extensions` 会把加载副本调和到配置的 ref（这里就是 `main` 的最新提交）
- git 包按 ref 钉住：改了代码必须 push，光在本地改没用
- 只改文档也要 push 才会到加载副本，但不影响功能，可以攒着一起推

### 版本与 CHANGELOG 规则

Pi 靠 `package.json` 的 `version` **递增**来决定是否展示 `CHANGELOG.md` 里的新条目，
所以两者必须一起改：

| 改动 | 怎么做 |
| --- | --- |
| 用户可见的新功能 / 行为变化 | `minor` + CHANGELOG 加 `## [x.y.0] - 日期` 段 |
| 只修 bug | `patch` + CHANGELOG 加条目 |
| 只改文档 / CI / 测试 | 不动版本；确实想发一版再 `patch` |

版本不变时 `pi update --extensions` 仍会把内容同步过去，只是不会给你看变更说明。

## 日常用法

每轮答完后弹出多选列表：

| 按键 | 作用 |
| --- | --- |
| `空格` | 勾选 / 取消当前候选 |
| `↑` `↓` / `k` `j` | 移动 |
| `回车` | 把勾选集填进输入框（**不发送**，不执行） |
| `p` | 把勾选集派发到新窗格（先选终端，再确认） |
| `Esc` | 关掉，候选留着 |

命令：

| 命令 | 作用 |
| --- | --- |
| `/next` | 重新打开选择器 |
| `/next pane` | 打开选择器且回车即「派发」 |
| `/next panes` | 列出这个会话派发过的窗格（provider · 窗格 id · 当初的标题），**选中即跳过去** |
| `/next focus [n]` | 跳到第 n 个最近派发的窗格（默认最新） |
| `/next on` / `/next off` | 开关自动建议 |

成功提示会带上 pane 的 `otty://pane/<id>` deeplink，`/next panes` / `/next focus` 是它的键盘版本。

派发是**互斥**的：从按 `p` 到窗格拉起来之间要过 picker / confirm / 写盘，这期间再触发
会直接提示「上一次派发还在进行」并放弃，不会给你开出两个窗格。

## 派发到底做了什么

1. 勾选的 1~N 条写进 handoff 文件：`$TMPDIR/pi-next-handoff/<时间戳>-<pid>.md`
   （每次派发写一对 `.md` + `.sh`，目录里只保留最近 20 次，更早的在下次派发时清掉）
2. 旁边生成一个 runner 脚本，内容是
   `exec <pi 绝对路径> --fork <session.jsonl> @<handoff.md>`
   —— 所以新会话有完整历史，但 session 是独立的
3. 在**当前 tab 里**开一块新窗格跑它（不是新窗口）

窗格是真窗格：

| 终端 | 机制 | 平台 |
| --- | --- | --- |
| Otty | `otty-cli pane split`（IPC） | macOS |
| tmux | `tmux split-window` | 任意 |
| zellij | `zellij action new-pane` | 任意 |
| wezterm | `wezterm cli split-pane` | 任意 |
| Ghostty | AppleScript `split`（`Ghostty.sdef`；CLI 没有 split 动作） | macOS |

只列当前环境真能用的入口。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `PI_BIN` | `~/.pi/agent/bin/pi`，找不到再扫 `PATH` | runner 执行的二进制 |
| `OTTY_CLI` | `/Applications/Otty.app/Contents/MacOS/otty-cli` | Otty 控制 CLI |
| `GHOSTTY_APP` | `/Applications/Ghostty.app` | Ghostty bundle（AppleScript 目标） |
| `PI_NEXT_STEPS_MODEL` | 会话里最便宜的已认证模型 | 生成候选用的模型 |

命令行旗标 `--next-model provider/model-id` 优先级高于 `PI_NEXT_STEPS_MODEL`。

以上都在**扩展模块加载时读一次**，改完要 `/reload`。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 窗格里 `exec: pi: not found` | runner 已写入绝对 `PI_BIN` 并复制了 pi 自己的 `PATH`；若仍报，设 `PI_BIN=/path/to/pi` 后 `/reload` |
| Ghostty 报 `-1743` | 系统设置 → 隐私与安全性 → 自动化，允许宿主终端控制 Ghostty |
| `/next` 出现两次 | 有第二份同扩展在加载（旧文件或另一个包） |
| 提示说「任务清单已交给它」但窗格里没东西 | 本扩展**不做就绪探测**；失败原因由 runner 直接打在那个窗格里 |
| `bun test` 解析不到 `@earendil-works/pi-tui` | 三个可能：① 在 `tests/` 里跑的（要在仓库根跑）；② 没 `bun install`；③ 没 bun install 也没本机 pi 安装 |

## 开发

```
.
├── extensions/next-steps.ts     # 扩展本体
├── tests/
│   ├── next-steps.test.ts       # 40 个用例
│   └── setup.ts                 # bun preload：把 @earendil-works/pi-tui 指向本机 pi 安装
├── bunfig.toml                  # 挂 preload（必须在仓库根）
├── tsconfig.json                # tsc --noEmit 的配置
├── package.json                 # peerDependencies 声明宿主提供的 pi 包
├── CHANGELOG.md
└── LICENSE
```

先装依赖，再跑检查：

```bash
bun install          # 只为类型检查和测试装 devDependencies
bun run typecheck    # tsc --noEmit
bun test             # 40 个用例
bun run check        # 上面两步一起
```

CI（`.github/workflows/ci.yml`）跑的就是 `typecheck` + `test`，每次 push 到 `main`
或开 PR 都会执行。

`bunfig.toml` 放在仓库根，preload 指向 `tests/setup.ts`。在 `tests/` 目录里直接
`bun test` 拿不到这份 preload，会报解析不到 `@earendil-works/pi-tui`。

`tests/setup.ts` 把 `@earendil-works/pi-tui` 映射到真实实现，按顺序找：

1. 仓库自己的 `node_modules`（`bun install` 装过 devDependencies —— CI 走这条）
2. 本机 pi 安装里的副本（走 `PI_MANAGED_INSTALL_ROOT` 或
   `~/.pi/agent/install/current-version`）

两条都不通就报错，不会静默用假实现。所以全新 clone 只要 `bun install` 就能跑，
不需要本机装 pi。

改了扩展想立刻验证，不要装包，直接隔离加载：

```bash
pi -p -ne -e ./extensions/next-steps.ts --no-tools "ok"
```

`-ne` 关掉扩展自动发现，只加载这一个，用来确认依赖解析和初始化没炸。

## License

GPL-3.0，见 [LICENSE](LICENSE)。
