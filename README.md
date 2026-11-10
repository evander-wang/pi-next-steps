# pi-next-steps

给 [Pi](https://pi.dev) 用的扩展：每轮回答结束后给出最多 3 条「下一步」候选。
回车只是把候选填进输入框，**永远不会自动执行**；按 `p` 才会把勾选的任意 1~N 条
交给一个**继承了当前会话上下文的独立 agent**，在**新窗格里**跑。

## 它能做什么

- 每轮结束自动生成 1~3 条具体候选（便宜模型跑，20s 超时，失败静默）
- 多选：空格勾选，回车把勾选集拼成一条消息填进输入框（你改完自己发）
- 勾 1~N 条按 `p`：选终端 → 确认 → 新窗格里起一个独立会话按清单干
- `/next focus` 一键跳回上次派发的窗格

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
| `/next focus [n]` | 跳到第 n 个最近派发的窗格（默认最新） |
| `/next on` / `/next off` | 开关自动建议 |

成功提示会带上 pane 的 `otty://pane/<id>` deeplink，`/next focus` 是它的键盘版本。

## 派发到底做了什么

1. 勾选的 1~N 条写进 handoff 文件：`$TMPDIR/pi-next-handoff/<时间戳>-<pid>.md`
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
| `bun test` 解析不到 `@earendil-works/pi-tui` | 两个可能：① 在 `tests/` 里跑的（要在仓库根跑）；② 本机没有 pi 安装 |

## 开发

```
.
├── extensions/next-steps.ts     # 扩展本体
├── tests/
│   ├── next-steps.test.ts       # 40 个用例
│   └── setup.ts                 # bun preload：把 @earendil-works/pi-tui 指向本机 pi 安装
├── bunfig.toml                  # 挂 preload（必须在仓库根）
├── package.json                 # peerDependencies 声明宿主提供的 pi 包
├── CHANGELOG.md
└── LICENSE
```

跑测试（**在仓库根执行**）：

```bash
bun test
```

`bunfig.toml` 放在仓库根，preload 指向 `tests/setup.ts`。在 `tests/` 目录里直接
`bun test` 拿不到这份 preload，会报解析不到 `@earendil-works/pi-tui`。

`tests/setup.ts` 通过 `PI_MANAGED_INSTALL_ROOT` 或
`~/.pi/agent/install/current-version` 找到当前 pi 的安装目录，再把
`@earendil-works/pi-tui` 映射到里面的真实实现 —— 扩展目录自身没有 `node_modules`。
所以**全新 clone 也能跑，但必须先有本地 pi 安装**。

改了扩展想立刻验证，不要装包，直接隔离加载：

```bash
pi -p -ne -e ./extensions/next-steps.ts --no-tools "ok"
```

`-ne` 关掉扩展自动发现，只加载这一个，用来确认依赖解析和初始化没炸。

## License

GPL-3.0，见 [LICENSE](LICENSE)。
