import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const WIDGET_KEY = "next-steps";

// U+26A1 默认是文字呈现，不加 VS16 终端会取 Nerd Font 的单色线稿字形
// 而不是彩色 emoji。与 token-speed.ts 保持一致。
const BOLT_ICON = "\u26A1\uFE0F";

/** 建议模型超时：超过就静默放弃，不打扰。 */
const TIMEOUT_MS = 20_000;

/** 只回传最后这条回复的尾部，不发 transcript / 工具输出 / 文件内容。 */
const TAIL_CHARS = 8_000;

/** 候选条数：太少没得选，太多看不过来。 */
const MAX_CANDIDATES = 3;

/** 单条候选长度上限，防模型跑飞。 */
const MAX_CANDIDATE_CHARS = 200;

/** 失效哨兵：模型认为没有有价值的下一步。 */
const NONE_SENTINEL = "NONE";

/** 选择器里的重跑项。 */
const REGENERATE_LABEL = "\u21bb 重新生成";

const PICKER_TITLE = "下一步 · 空格勾选 · Enter 填入输入框 · p 独立执行";
const PICKER_HELP = "空格 勾选 · ↑↓ 移动 · Enter 填入输入框 · p 在独立窗格执行 · Esc 关闭";
const PICKER_HELP_PANE = "空格 勾选 · ↑↓ 移动 · Enter 在独立窗格执行 · Esc 关闭";

/** 勾选集投递到哪：填入输入框（原有行为），还是独立窗格里跑。 */
export type SpawnMode = "edit" | "pane";

export interface PickerResult {
  picked: string[];
  mode: SpawnMode;
}

/**
 * 独立执行的入口。
 *
 * 概念统一：window > tab > pane。这里每一个入口都是「在当前 tab 里新开一块 pane」，
 * 不新开窗口：
 *   - otty    : `pane split`（同 tab 的兄弟 pane）
 *   - tmux    : `split-window`（tmux 的 window 就是别人的 tab）
 *   - zellij  : `action new-pane`
 *   - wezterm : `cli split-pane`
 *   - ghostty : Ghostty.sdef 的 AppleScript `split`（CLI 没有 split 动作）
 */
export type SpawnProvider = "otty" | "tmux" | "zellij" | "wezterm" | "ghostty";

export interface SpawnTarget {
  provider: SpawnProvider;
  /** 选择器和确认框里展示给人的说法，同时候选项的 key。 */
  label: string;
  /** tmux：不在 tmux 里时要指定挂着的会话。 */
  tmuxTarget?: string;
  /** otty：锚点 pane 及其列数。 */
  ottyPane?: string;
  ottyCols?: number;
}

/** 可选项的展示顺序。 */
export const PROVIDER_ORDER: SpawnProvider[] = [
  "otty",
  "tmux",
  "zellij",
  "wezterm",
  "ghostty",
];

/** Otty CLI 的绝对路径（不在 PATH 上）。可用 OTTY_CLI 覆盖。 */
export const OTTY_CLI =
  process.env.OTTY_CLI ?? "/Applications/Otty.app/Contents/MacOS/otty-cli";

/** Ghostty 走 AppleScript，用不到 CLI 路径，只用来判断有没有装。可用 GHOSTTY_APP 覆盖。 */
export const GHOSTTY_APP =
  process.env.GHOSTTY_APP ?? "/Applications/Ghostty.app";

/** 派生会话 handoff 与 runner 脚本的落盘目录。 */
export const HANDOFF_DIR = join(tmpdir(), "pi-next-handoff");

/** 临时目录里保留最近多少次派发的文件，更早的在下一次派发时清掉。 */
export const MAX_HANDOFFS = 20;

/** 锚点 pane 达到这个列数才适合左右分屏，否则上下分。 */
const WIDE_PANE_COLS = 120;

/** 记住最近几次派发，供 `/next focus` 跳转（新→旧）。 */
const MAX_RECENT = 5;

export interface PaneRow {
  id: string;
  active?: boolean;
  cols?: number;
  rows?: number;
  agent?: string;
  agent_session_id?: string;
}

/** 探针结果：能用就给出目标，不能用就给出人话原因。 */
export interface ProbeResult {
  target?: SpawnTarget;
  reason: string;
}

// ---------------------------------------------------------------- 小工具

/** POSIX 单引号包裹；内部单引号拆成 '\'' ，路径带空格也不会被拆散。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 异常 -> 一句人话，用于提示。 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** 压成一行并截断，给标题和报错用。 */
export function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat;
}

/**
 * "一个入口都没有" 时的一句话：逐个原因都列出来，并给出 handoff 路径。
 *
 * 单行拼接，不走多行 —— notify 一般只显示一两行。
 */
export function describeNoTargets(reasons: string[], handoff: string): string {
  const detail = reasons.length > 0 ? reasons.join(" / ") : "没有探测到任何终端";
  return `没有可用终端入口（${detail}）${handoff ? `；handoff 已写到 ${handoff}` : ""}`;
}

/** 选择器里的选项文案：provider · 新窗格 · 具体位置。 */
export function labelOf(provider: SpawnProvider, detail: string): string {
  return `${provider} · 新窗格 · ${detail}`;
}

/** AppleScript 字符串字面量：反斜杠和双引号要转义。 */
export function asQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------- Otty 探针

/** 读 Otty 的 pane 列表；没装、没运行、socket 断了都返回 undefined，不抛。 */
export async function listPanes(pi: ExtensionAPI): Promise<PaneRow[] | undefined> {
  try {
    const result = await pi.exec(OTTY_CLI, ["pane", "list", "--json"], {
      timeout: 4000,
    });
    if (result.code !== 0) return undefined;
    const parsed = JSON.parse(result.stdout) as { data?: PaneRow[] };
    return Array.isArray(parsed.data) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 锚点 pane：$OTTY_PANE_ID → 本会话所在的 Pi pane → 当前焦点 pane。
 *
 * 三级都不中就不猜：宁可不执行，也不要在一个莫名其妙的 pane 里开分屏。
 */
export function pickAnchor(
  panes: PaneRow[] | undefined,
  sessionFile: string | undefined,
): PaneRow | undefined {
  const envPane = (process.env.OTTY_PANE_ID ?? "").trim();
  if (!panes || panes.length === 0) return envPane ? { id: envPane } : undefined;

  if (envPane) {
    const own = panes.find((pane) => pane.id === envPane);
    if (own) return own;
  }
  if (sessionFile) {
    const key = basename(sessionFile).replace(/\.jsonl$/, "");
    const own = panes.find(
      (pane) => pane.agent === "Pi" && pane.agent_session_id === key,
    );
    if (own) return own;
  }
  return panes.find((pane) => pane.active);
}

// ---------------------------------------------------------------- handoff 落盘

/**
 * 勾选集打包成 handoff 文件。
 *
 * 写成文件而不是拼进命令行：1~N 条里的换行和引号不用转义，新窗格用 @path 读。
 */
export async function writeHandoff(
  ctx: ExtensionContext,
  items: string[],
  forked: boolean,
): Promise<string> {
  await mkdir(HANDOFF_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(HANDOFF_DIR, `${stamp}-${process.pid}.md`);
  const sessionFile = ctx.sessionManager.getSessionFile() ?? "";

  const lines: string[] = [
    "---",
    `from: ${sessionFile || "unknown"}`,
    `cwd: ${ctx.sessionManager.getCwd()}`,
    `created: ${new Date().toISOString()}`,
    `items: ${items.length}`,
    `context: ${forked ? "fork" : "clean"}`,
    "---",
    "",
    "# 交接任务",
    "",
  ];
  if (forked) {
    lines.push("本会话已从上面的来源会话 fork，旧上下文都在历史里，不需要复述。", "");
  }
  lines.push("## 任务清单（按顺序执行，做完一条先回报再继续下一条）", "");
  items.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  lines.push("", "## 边界", "");
  lines.push("- 只做清单内的事；计划外发现单独提出，不顺手扩大范围");
  if (items.length >= 3) {
    lines.push("- 三条以上，先复述清单确认理解，再动手");
  }
  lines.push("");

  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}

/**
 * 找 pi 可执行文件。
 *
 * 裸 `pi` 靠 PATH 解析会翻车：新开的登录 shell 里 PATH 和当前进程不同，
 * 于是 `exec: pi: not found`。这里一次性解析成绝对路径写进 runner。
 */
export function resolvePiBin(): string {
  const explicit = (process.env.PI_BIN ?? "").trim();
  if (explicit) return explicit;

  const managed = join(homedir(), ".pi", "agent", "bin", "pi");
  if (existsSync(managed)) return managed;

  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "pi");
    if (existsSync(candidate)) return candidate;
  }
  return "pi";
}

/**
 * runner 里要前置到 PATH 的目录。
 *
 * 托管 pi 是个 sh 包装脚本，它自己还要靠 PATH 找 node —— 光给绝对路径不够，
 * 新开的登录 shell 里既没有 pi 也没有 node，所以两个目录都补上。
 */
export function runtimePathDirs(): string[] {
  const dirs: string[] = [];
  const bin = resolvePiBin();
  if (bin.includes("/")) dirs.push(dirname(bin));
  if (process.execPath) dirs.push(dirname(process.execPath));
  return [...new Set(dirs)];
}

/** 传给 pi 的参数。任务正文走 @file，命令行里只有路径。 */
export function piArgs(sessionFile: string | undefined, handoff: string): string {
  const args: string[] = [];
  if (sessionFile) args.push("--fork", shellQuote(sessionFile));
  args.push(`@${shellQuote(handoff)}`);
  return args.join(" ");
}

/** 完整的一行 pi 命令（含绝对路径）。 */
export function piArgv(sessionFile: string | undefined, handoff: string): string {
  return `${shellQuote(resolvePiBin())} ${piArgs(sessionFile, handoff)}`;
}

/**
 * runner 脚本：每个入口对命令行的解析规则不一样（Otty 丢给 shell、Ghostty 按
 * surface configuration 走、wezterm/zellij 按 argv），所以统一包一层无参数、
 * 无空格的 .sh 路径。
 */
export async function writeRunner(
  sessionFile: string | undefined,
  handoff: string,
): Promise<string> {
  const script = handoff.replace(/\.md$/, ".sh");
  const bin = resolvePiBin();
  // 直接用 pi 自己的 PATH：托管 pi 是 sh 包装脚本，还要靠 PATH 找 node，
  // 而新开的登录 shell 未必和它一致。前置我们解析出的目录，其余照抄。
  const pathValue = [
    ...new Set([
      ...runtimePathDirs(),
      ...(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":"),
    ]),
  ]
    .filter(Boolean)
    .join(":");

  // 不用裸 pi：先落成变量并检查可执行，失败时给出能自己动手改的一行。
  const body = [
    "#!/bin/sh",
    "# 由 pi next-steps 生成：在独立窗格里跑这一批任务",
    `PATH=${shellQuote(pathValue)}`,
    "export PATH",
    `PI_BIN=${shellQuote(bin)}`,
    'if [ ! -x "$PI_BIN" ]; then',
    '  echo "next-steps: 找不到 pi 可执行文件：$PI_BIN"',
    '  echo "  → 设 PI_BIN=/path/to/pi 后重试 p"',
    "  exit 127",
    "fi",
    `exec "$PI_BIN" ${piArgs(sessionFile, handoff)}`,
    "",
  ].join("\n");
  await writeFile(script, body, "utf8");
  await chmod(script, 0o755);
  return script;
}

/**
 * 清理临时目录：只留最近 `keep` 次派发的文件。
 *
 * 每次派发写一对 `.md` + `.sh`，不清就会一直堆。文件名以 ISO 时间戳开头，
 * 字典序等于时间序，所以按 basename 排序取尾部即可。
 *
 * 返回删掉的文件数；读不到目录（没派发过）就当 0，永远不抛。
 */
export async function pruneHandoffs(
  keep = MAX_HANDOFFS,
  dir = HANDOFF_DIR,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }

  const entries = names
    .filter((name) => /\.(md|sh|log)$/.test(name))
    .map((name) => ({ name, base: name.replace(/\.(md|sh|log)$/, "") }));

  const bases = [...new Set(entries.map((entry) => entry.base))].sort();
  const doomed = new Set(bases.slice(0, Math.max(0, bases.length - keep)));
  if (doomed.size === 0) return 0;

  let removed = 0;
  for (const entry of entries) {
    if (!doomed.has(entry.base)) continue;
    try {
      await rm(join(dir, entry.name), { force: true });
      removed += 1;
    } catch {
      // 单个文件删不掉不影响其它，也不该让派发失败
    }
  }
  return removed;
}

// ---------------------------------------------------------------- 各终端探针

/** Otty：要跑着的 app + 能定位的锚点 pane。 */
export async function probeOtty(
  pi: ExtensionAPI,
  sessionFile: string | undefined,
): Promise<ProbeResult> {
  const panes = await listPanes(pi);
  if (!panes) return { reason: "控制 socket 没响应（app 未运行或 CLI 缺失）" };
  const anchor = pickAnchor(panes, sessionFile);
  if (!anchor) return { reason: "app 在跑，但定位不到锚点 pane" };
  return {
    target: {
      provider: "otty",
      label: labelOf("otty", `${anchor.id}（${anchor.cols ?? "?"} 列）`),
      ottyPane: anchor.id,
      ottyCols: anchor.cols,
    },
    reason: "",
  };
}

/** tmux：在 tmux 里就直接分；不在也可以分到用户挂着的那个会话去。 */
export async function probeTmux(pi: ExtensionAPI): Promise<ProbeResult> {
  if ((process.env.TMUX ?? "").trim()) {
    return {
      target: { provider: "tmux", label: labelOf("tmux", "当前窗口") },
      reason: "",
    };
  }
  try {
    const result = await pi.exec(
      "tmux",
      ["list-clients", "-F", "#{client_session}"],
      { timeout: 2000 },
    );
    if (result.code !== 0) {
      return { reason: `无部署（${clip(result.stderr || "没有 tmux 服务", 60)}）` };
    }
    const session = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!session) return { reason: "有服务但没有挂着的客户端" };
    return {
      target: {
        provider: "tmux",
        label: labelOf("tmux", `会话 ${session}`),
        tmuxTarget: session,
      },
      reason: "",
    };
  } catch {
    return { reason: "命令不在 PATH 上" };
  }
}

export function probeZellij(): ProbeResult {
  return (process.env.ZELLIJ ?? "").trim()
    ? { target: { provider: "zellij", label: labelOf("zellij", "当前会话") }, reason: "" }
    : { reason: "不在 zellij 里" };
}

export function probeWezterm(): ProbeResult {
  return (process.env.WEZTERM_PANE ?? "").trim()
    ? { target: { provider: "wezterm", label: labelOf("wezterm", "当前窗口") }, reason: "" }
    : { reason: "不在 wezterm 里" };
}

/**
 * Ghostty：CLI 没有 split，但 Ghostty.sdef 暴露了 AppleScript 的 `split`，
 * 所以在当前 tab 里开真窗格是可行的。要求 app 在跑且至少有一个窗口。
 */
export async function probeGhostty(pi: ExtensionAPI): Promise<ProbeResult> {
  if (process.platform !== "darwin") return { reason: "AppleScript 入口只有 macOS 有" };
  if (!existsSync(GHOSTTY_APP)) return { reason: "没装 Ghostty.app" };
  try {
    const result = await pi.exec(
      "osascript",
      ["-e", 'tell application "Ghostty" to return (count of windows)'],
      { timeout: 4000 },
    );
    if (result.code !== 0) {
      return { reason: `AppleScript 调不通（${clip(result.stderr, 60)}）` };
    }
    const windows = Number(result.stdout.trim());
    if (!Number.isFinite(windows) || windows < 1) {
      return { reason: "app 在跑但没有窗口" };
    }
    return {
      target: { provider: "ghostty", label: labelOf("ghostty", "当前 tab") },
      reason: "",
    };
  } catch {
    return { reason: "osascript 不可用" };
  }
}

// ---------------------------------------------------------------- 跳转

/** 一次派发的落地记录，供 `/next focus` 用。 */
export interface SpawnRecord {
  provider: SpawnProvider;
  /** otty pane id 或 ghostty terminal id；tmux/zellij/wezterm 没有。 */
  handle: string;
  /** 可跳转的 deeplink（目前只有 otty 提供）。 */
  link?: string;
  title: string;
  items: string[];
}

/** 取 otty 的 pane deeplink；拿不到就是 undefined，不影响主流程。 */
export async function paneLink(
  pi: ExtensionAPI,
  paneId: string,
): Promise<string | undefined> {
  try {
    const result = await pi.exec(OTTY_CLI, ["pane", "link", "--pane", paneId, "--json"], {
      timeout: 3000,
    });
    if (result.code !== 0) return undefined;
    const url = (JSON.parse(result.stdout) as { data?: { url?: string } }).data?.url;
    return url ?? undefined;
  } catch {
    return undefined;
  }
}

/** 把某个落地窗格拉到眼前。只有 otty / ghostty 有跳转入口。 */
export async function focusSpawn(
  pi: ExtensionAPI,
  record: SpawnRecord,
): Promise<SpawnOutcome> {
  const fail = (detail: string): SpawnOutcome => ({ ok: false, detail });
  try {
    if (record.provider === "otty") {
      const result = await pi.exec(
        OTTY_CLI,
        ["pane", "focus", "--pane", record.link ?? record.handle],
        { timeout: 4000 },
      );
      return result.code === 0
        ? { ok: true, detail: record.handle }
        : fail(`exit ${result.code}·${clip(result.stderr || result.stdout, 120)}`);
    }
    if (record.provider === "ghostty") {
      const lines = [
        'tell application "Ghostty"',
        "repeat with w in windows",
        "repeat with tb in tabs of w",
        "repeat with term in terminals of tb",
        `if id of term is ${asQuote(record.handle)} then`,
        "focus term",
        "return true",
        "end if",
        "end repeat",
        "end repeat",
        "end repeat",
        "return false",
        "end tell",
      ];
      const result = await pi.exec(
        "osascript",
        lines.flatMap((line) => ["-e", line]),
        { timeout: 6000 },
      );
      if (result.code !== 0) return fail(clip(result.stderr, 120));
      return result.stdout.trim() === "true"
        ? { ok: true, detail: record.handle }
        : fail("那个 Ghostty 窗格已经不在了");
    }
    return fail(`${record.provider} 没有跳转入口（只有 otty / ghostty 有）`);
  } catch (error) {
    return fail(messageOf(error));
  }
}

// ---------------------------------------------------------------- 派发

export type SpawnOutcome =
  | { ok: true; detail: string; paneId?: string }
  | { ok: false; detail: string };

/** 按 provider 把 runner 脚本拉到新窗格里去。 */
export async function spawnVia(
  pi: ExtensionAPI,
  target: SpawnTarget,
  cwd: string,
  script: string,
  title: string,
): Promise<SpawnOutcome> {
  try {
    return await spawnViaUnsafe(pi, target, cwd, script, title);
  } catch (error) {
    // exec 自己炸了（二进制不存在、IPC 断裂）也算失败，不让异常冒到 UI 外面。
    return { ok: false, detail: messageOf(error) };
  }
}

async function spawnViaUnsafe(
  pi: ExtensionAPI,
  target: SpawnTarget,
  cwd: string,
  script: string,
  title: string,
): Promise<SpawnOutcome> {
  const fail = (detail: string): SpawnOutcome => ({ ok: false, detail });
  const fromResult = (
    result: { code: number; stderr: string; stdout: string },
    detail: string,
  ): SpawnOutcome =>
    result.code === 0
      ? { ok: true, detail }
      : fail(`exit ${result.code}·${clip(result.stderr || result.stdout || "", 160)}`);

  if (target.provider === "otty" && target.ottyPane) {
    const direction = (target.ottyCols ?? 0) >= WIDE_PANE_COLS ? "right" : "down";
    const result = await pi.exec(
      OTTY_CLI,
      [
        "pane",
        "split",
        "--pane",
        target.ottyPane,
        "--direction",
        direction,
        "--cwd",
        cwd,
        "--no-focus",
        "--title",
        title,
        "--command",
        script,
        "--json",
      ],
      { timeout: 8000 },
    );
    let paneId = "";
    try {
      paneId = (JSON.parse(result.stdout) as { data?: { id?: string } }).data?.id ?? "";
    } catch {
      paneId = "";
    }
    if (result.code !== 0 || !paneId) {
      let detail = clip(result.stderr || result.stdout, 160);
      try {
        const parsed = JSON.parse(result.stdout) as {
          error?: { code?: string; message?: string };
        };
        if (parsed.error?.code) {
          detail = `${parsed.error.code}${parsed.error.message ? `·${parsed.error.message}` : ""}`;
        }
      } catch {
        // stdout 不是 JSON 就沿用上面的原文
      }
      return fail(`exit ${result.code}·${detail}`);
    }
    return { ok: true, detail: paneId, paneId };
  }

  if (target.provider === "tmux") {
    const args = ["split-window", "-h", "-c", cwd];
    if (target.tmuxTarget) args.push("-t", target.tmuxTarget);
    args.push(script);
    return fromResult(await pi.exec("tmux", args, { timeout: 8000 }), "tmux 新窗格");
  }

  if (target.provider === "zellij") {
    return fromResult(
      await pi.exec("zellij", ["action", "new-pane", "--", script], { timeout: 8000 }),
      "zellij 新窗格",
    );
  }

  if (target.provider === "wezterm") {
    return fromResult(
      await pi.exec("wezterm", ["cli", "split-pane", "--", script], { timeout: 8000 }),
      "wezterm 新窗格",
    );
  }

  if (target.provider === "ghostty") {
    // 在当前 tab 里 split 出一块，并把 runner 作为它的启动命令。
    const lines = [
      'tell application "Ghostty"',
      "set w to front window",
      "set t to focused terminal of selected tab of w",
      "set cfg to new surface configuration",
      `set command of cfg to ${asQuote(script)}`,
      `set initial working directory of cfg to ${asQuote(cwd)}`,
      "set newT to split t direction right with configuration cfg",
      "return id of newT",
      "end tell",
    ];
    const result = await pi.exec(
      "osascript",
      lines.flatMap((line) => ["-e", line]),
      { timeout: 10000 },
    );
    const terminalId = result.stdout.trim();
    if (result.code !== 0 || !terminalId) {
      const hint = /-1743|not authori[sz]ed/i.test(result.stderr)
        ? "（系统设置 → 隐私与安全性 → 自动化里允许本终端控制 Ghostty）"
        : "";
      return fail(
        `exit ${result.code}·${clip(
          result.stderr || result.stdout || "没有返回终端 id",
          120,
        )}${hint}`,
      );
    }
    return { ok: true, detail: terminalId, paneId: terminalId };
  }

  return fail(`unknown provider ${target.provider}`);
}

// ---------------------------------------------------------------- 建议生成

type AnyModel = Model<Api>;

type TextContentLike = string | { type: string; text?: string }[] | undefined;

/** 会话条目里用得到的字段（结构取自 sessionManager.getBranch()）。 */
interface SessionEntryLike {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    content?: TextContentLike;
  };
}

function contentText(content: TextContentLike): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/**
 * 取最后一条 assistant 回复的尾部。
 *
 * 拿不到合适的上文就返回 null：工具中途（stopReason 不是 stop）、
 * 中止、报错的回复都不适合猜下一步。
 */
function lastAssistantTail(ctx: ExtensionContext): string | null {
  const entries = ctx.sessionManager.getBranch() as unknown as SessionEntryLike[];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "stop") return null;
    const text = contentText(message.content).trim();
    return text ? text.slice(-TAIL_CHARS) : null;
  }
  return null;
}

const SYSTEM_PROMPT = [
  "You propose next steps in a coding-agent session.",
  "Given the assistant's final message, output up to 3 candidate replies the user might send next.",
  "Rules:",
  "- one candidate per line, no numbering, no bullets, no quotes",
  "- each under 120 characters, imperative or a direct question",
  "- each must be distinct and concrete; prefer a real next action over vague praise",
  "- if the message ends with a pending decision, at least one candidate must be a direct answer to it",
  `- if nothing useful follows, output exactly ${NONE_SENTINEL}`,
].join("\n");

/** 把模型输出拆成候选：去编号/项目符号/引号，去重，截断，防空。 */
function parseCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.toUpperCase() === NONE_SENTINEL) return [];
    line = line
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^["'`]+|["'`]+$/g, "")
      .trim();
    if (!line) continue;
    if (line.length > MAX_CANDIDATE_CHARS) {
      line = line.slice(0, MAX_CANDIDATE_CHARS).trimEnd();
    }
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(line);
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  return candidates;
}

function modelLabel(model: AnyModel): string {
  return `${model.provider}/${model.id}`;
}

/** 便宜的模型通常带这些字样的名字，用它跑建议比拿主模型便宜。 */
const CHEAP_MODEL_PATTERN = /(flash|mini|lite|small|haiku|nano|tiny|fast)/i;

/**
 * 挑一个跑建议的模型。
 *
 * 顺序：--next-model 旗标 → PI_NEXT_STEPS_MODEL 环境变量 → 会话内最便宜的那个 →
 * 当前会话模型兜底。显式指定写错时退回自动挑选，不静默失败。
 */
function pickModel(pi: ExtensionAPI, ctx: ExtensionContext): AnyModel | undefined {
  const registry = ctx.modelRegistry;
  const flag = pi.getFlag("next-model");
  const explicit =
    (typeof flag === "string" && flag.trim()) ||
    (process.env.PI_NEXT_STEPS_MODEL ?? "").trim();

  if (explicit) {
    const slash = explicit.indexOf("/");
    const found =
      slash > 0
        ? registry.find(explicit.slice(0, slash), explicit.slice(slash + 1))
        : registry.getAll().find((model) => model.id === explicit);
    if (found && registry.hasConfiguredAuth(found)) return found;
  }

  const pool =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((scoped) => scoped.model)
      : registry.getAll();
  const usable = pool.filter((model) => registry.hasConfiguredAuth(model));
  const cheap =
    usable.find(
      (model) => CHEAP_MODEL_PATTERN.test(model.id) && model.id !== ctx.model?.id,
    ) ?? usable.find((model) => CHEAP_MODEL_PATTERN.test(model.id));

  return cheap ?? ctx.model;
}

// ---------------------------------------------------------------- 选择器 UI

/** 只需要 theme.fg，用结构类型避免和宿主 Theme 类耦合。 */
interface DialogTheme {
  fg(color: string, text: string): string;
}

/**
 * 多选列表：空格勾选，↑↓ 移动，Enter 确认，p 派发，Esc 取消。
 *
 * 内置的 ui.select 只能单选，所以这里用 ctx.ui.custom() 自己画。
 */
export class MultiSelectDialog implements Component {
  private index = 0;
  private readonly checked = new Set<number>();

  constructor(
    private readonly items: string[],
    private readonly theme: DialogTheme,
    private readonly done: (result: PickerResult | undefined) => void,
    private readonly enterMode: SpawnMode = "edit",
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const lineWidth = Math.max(24, width);
    const rows = this.items.map((item, i) => {
      const cursor = i === this.index ? this.theme.fg("accent", "→") : " ";
      const box = this.checked.has(i)
        ? this.theme.fg("success", "[x]")
        : this.theme.fg("dim", "[ ]");
      const label = i === this.index ? this.theme.fg("accent", item) : item;
      return truncateToWidth(`${cursor}${box} ${label}`, lineWidth);
    });
    const help = this.enterMode === "pane" ? PICKER_HELP_PANE : PICKER_HELP;
    return [truncateToWidth(this.theme.fg("dim", help), lineWidth), ...rows];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "up") || data === "k") {
      this.index = Math.max(0, this.index - 1);
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.index = Math.min(this.items.length - 1, this.index + 1);
      return;
    }
    if (data === " " || matchesKey(data, "space")) {
      this.toggle();
      return;
    }
    if (matchesKey(data, "enter") || data === "\n") {
      this.done({ picked: this.pickedItems(), mode: this.enterMode });
      return;
    }
    // p 是单次触发，不改 Enter 语义，也不记状态：想开窗格就每次显式按。
    if (data === "p") {
      this.done({ picked: this.pickedItems(), mode: "pane" });
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done(undefined);
    }
  }

  /** 勾了就用勾的；一条没勾就把光标那条当选中（保留单选时代的肌肉记忆）。 */
  private pickedItems(): string[] {
    const picked = this.items.filter((_, i) => this.checked.has(i));
    return picked.length > 0 ? picked : [this.items[this.index]!];
  }

  /** 「重新生成」与具体候选互斥：勾它清掉其他，勾其他清掉它。 */
  private toggle(): void {
    const index = this.index;
    if (this.checked.delete(index)) return;

    const regenerateIndex = this.items.indexOf(REGENERATE_LABEL);
    if (index === regenerateIndex) {
      this.checked.clear();
    } else {
      this.checked.delete(regenerateIndex);
    }
    this.checked.add(index);
  }
}

// ---------------------------------------------------------------- 主体

class NextSteps {
  private candidates: string[] = [];
  private abort: AbortController | null = null;
  private generationId = 0;
  private lifecycleId = 0;
  private autoEnabled = true;
  /** 失败警告按会话+模型去重，别每轮都弹一遍。 */
  private warnedScope: string | undefined;
  /** 最近一次生成用的模型，Esc 后补画常驻列表时要显示它。 */
  private model: AnyModel | undefined;
  /** 最近的落地记录，供 `/next focus` 跳回去。 */
  private recent: SpawnRecord[] = [];

  constructor(private readonly pi: ExtensionAPI) {}

  onSessionStart(ctx: ExtensionContext): void {
    this.lifecycleId += 1;
    this.cancel();
    this.clear(ctx);
  }

  onAgentStart(ctx: ExtensionContext): void {
    // 新一轮开始：旧建议立刻作废，避免拿上一轮的上文误导你。
    this.lifecycleId += 1;
    this.cancel();
    this.clear(ctx);
  }

  /**
   * 答完后的入口。同步返回，后台跑生成 + 弹选择器。
   *
   * 不 await：agent_settled 的 handler 是顺序 await 的，在这里等用户选完会
   * 拖住其他扩展的 settled 逻辑。
   */
  onAgentSettled(event: { aborted: boolean }, ctx: ExtensionContext): void {
    if (!this.autoEnabled || event.aborted) return;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    // 你正在打字就不插话。
    if (ctx.ui.getEditorText() !== "") return;

    const tail = lastAssistantTail(ctx);
    if (!tail) return;

    void (async () => {
      if (await this.generate(ctx, tail)) await this.ask(ctx);
    })().catch((error) => {
      this.warnOnce(ctx, ctx.model ?? undefined, messageOf(error));
    });
  }

  /** 生成候选并画到 widget 上。返回是否拿到候选。 */
  private async generate(ctx: ExtensionContext, tail: string): Promise<boolean> {
    const model = pickModel(this.pi, ctx);
    if (!model) return false;

    // 先作废上一轮请求（cancel 会 bump generationId），再取本次的 id，
    // 顺序反了会把自己判成过期，永远出不来建议。
    this.cancel();
    const id = ++this.generationId;
    const lifecycleId = this.lifecycleId;
    const abort = new AbortController();
    this.abort = abort;
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

    try {
      const message = await ctx.modelRegistry
        .streamSimple(
          model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `<assistant_message>\n${tail}\n</assistant_message>\n\nNext steps:`,
                  },
                ],
                timestamp: Date.now(),
              },
            ],
          },
          { signal: abort.signal, maxTokens: 200 },
        )
        .result();

      if (id !== this.generationId || lifecycleId !== this.lifecycleId) return false;
      if (abort.signal.aborted) return false;

      if (message.stopReason === "aborted") return false;
      if (message.stopReason === "error") {
        this.warnOnce(ctx, model, message.errorMessage ?? "请求失败");
        return false;
      }

      const candidates = parseCandidates(contentText(message.content));
      if (candidates.length === 0) {
        this.clear(ctx);
        return false;
      }
      this.candidates = candidates;
      this.model = model;
      // 不在这里画 widget：紧接着就会弹出选择器，两边都列一遍是重复。
      // 只有 Esc 掉选择器后才补画（见 ask）。
      return true;
    } catch (error) {
      if (id !== this.generationId || lifecycleId !== this.lifecycleId) return false;
      this.warnOnce(ctx, model, messageOf(error));
      return false;
    } finally {
      clearTimeout(timer);
      if (this.abort === abort) this.abort = null;
    }
  }

  /**
   * 弹出多选列表：↑↓ 移动，Enter 把候选填入输入框（不发送），p 派发，Esc 关掉。
   *
   * 选中只 setEditorText 不发消息，所以不存在「选中→执行→再建议」的回路。
   */
  private async ask(ctx: ExtensionContext, enterMode: SpawnMode = "edit"): Promise<void> {
    if (!ctx.hasUI) return;

    while (this.candidates.length > 0) {
      // 生成到你按下之间可能已经开始打字了，别抢焦点。
      if (ctx.ui.getEditorText() !== "") return;

      // 弹之前先把常驻列表收掉。否则 Esc 过一次后再 /next，屏幕上是
      // 「widget 列一遍 + 选择器又列一遍」两处同样的候选。
      this.hideWidget(ctx);

      const picked = await ctx.ui.custom<PickerResult | undefined>(
        (_tui, theme, _keybindings, done) =>
          new MultiSelectDialog(
            [...this.candidates, REGENERATE_LABEL],
            theme as DialogTheme,
            done,
            enterMode,
          ),
        { blocked: { kind: "question", message: PICKER_TITLE } },
      );

      // Esc，或者一条都没勾就 Enter：当取消处理，候选留着。
      if (picked === undefined || picked.picked.length === 0) {
        if (this.model) this.render(ctx, this.model);
        return;
      }
      if (picked.picked.length === 1 && picked.picked[0] === REGENERATE_LABEL) {
        const tail = lastAssistantTail(ctx);
        if (!tail || !(await this.generate(ctx, tail))) return;
        continue;
      }
      if (picked.mode === "pane") {
        let spawned = false;
        try {
          spawned = await this.dispatchToPane(ctx, picked.picked);
        } catch (error) {
          ctx.ui.notify(`next-steps: 派发失败：${messageOf(error)}`, "error");
        }
        // 派出去的这几条从候选里拿掉，剩下的还能接着选（再派 / 或填进输入框）。
        if (spawned) {
          this.candidates = this.candidates.filter(
            (item) => !picked.picked.includes(item),
          );
        }
        if (this.candidates.length === 0) {
          this.clear(ctx);
        } else if (this.model) {
          this.render(ctx, this.model);
        }
        return;
      }

      // 多条用换行拼成一条多行消息，你改完自己回车发出。
      ctx.ui.setEditorText(picked.picked.join("\n"));
      this.clear(ctx);
      return;
    }
  }

  /**
   * 勾选集 → 一个独立窗格：手动选终端，写 handoff + runner，再拉起来。
   *
   * 只有 p / `/next pane` 能走到这里；Enter 永远只是填输入框。
   * 返回 true 表示真的拉起来了，调用方据此把这几条从候选里移除。
   */
  private async dispatchToPane(
    ctx: ExtensionContext,
    items: string[],
  ): Promise<boolean> {
    const cwd = ctx.sessionManager.getCwd();
    const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

    let targets: SpawnTarget[] = [];
    let reasons: string[] = [];
    try {
      ({ targets, reasons } = await this.availableTargets(sessionFile));
    } catch (error) {
      ctx.ui.notify(`next-steps: 探测终端入口失败：${messageOf(error)}`, "error");
      return false;
    }

    if (targets.length === 0) {
      const fallback = await writeHandoff(ctx, items, Boolean(sessionFile)).catch(
        () => "",
      );
      ctx.ui.notify(`next-steps: ${describeNoTargets(reasons, fallback)}`, "warning");
      return false;
    }

    // 先选去哪里 —— 这一步就是为了让人看清楚到底开在哪个终端，不靠猜。
    let target = targets[0]!;
    if (targets.length > 1) {
      const choice = await ctx.ui.select(
        "在哪个终端开新窗格？",
        targets.map((item) => item.label),
      );
      if (choice === undefined) return false;
      target = targets.find((item) => item.label === choice) ?? targets[0]!;
    }

    const detail = [
      ...items.map((item, index) => `${index + 1}. ${item}`),
      "",
      `目标：${target.label}`,
      sessionFile ? "上下文：fork 当前会话（独立 session）" : "上下文：干净会话",
      "Enter 只填输入框；只有这一步才会真的开新进程。",
    ].join("\n");
    const confirmed = await ctx.ui.confirm(
      `独立执行（${items.length} 条）`,
      detail,
    );
    if (!confirmed) return false;

    let script = "";
    let title = "";
    try {
      const handoff = await writeHandoff(ctx, items, Boolean(sessionFile));
      script = await writeRunner(sessionFile, handoff);
      title = `next: ${clip(items[0]!, 32)}${items.length > 1 ? ` ×${items.length}` : ""}`;
    } catch (error) {
      ctx.ui.notify(
        `next-steps: 写 handoff / runner 失败（${cwd} 权限或磁盘）：${messageOf(error)}`,
        "error",
      );
      return false;
    }

    // 只留最近 MAX_HANDOFFS 次派发的文件；清理失败绝不能影响派发本身。
    await pruneHandoffs().catch(() => {});

    const outcome = await spawnVia(this.pi, target, cwd, script, title);
    if (!outcome.ok) {
      // 失败时把"能自己动手复现的那一行"也给人，别只丢一句 exit 1。
      ctx.ui.notify(
        `next-steps: ${target.label} 失败：${outcome.detail}；可手动跑 sh ${script}`,
        "error",
      );
      return false;
    }

    // 落地记录：拿 deeplink 供 /next focus 跳转。
    const link =
      outcome.paneId && target.provider === "otty"
        ? await paneLink(this.pi, outcome.paneId)
        : undefined;
    if (outcome.paneId) {
      this.recent.unshift({
        provider: target.provider,
        handle: outcome.paneId,
        link,
        title,
        items: [...items],
      });
      this.recent = this.recent.slice(0, MAX_RECENT);
    }
    const jump = link ? ` · 跳转 /next focus · ${link}` : " · 跳转 /next focus";

    // 窗格就在当前 tab 里、就在眼皮底下：开出来了就算成功，不去猜 pi 是否就绪。
    // 真启动失败的话，runner 会把原因直接打在那个窗格里。
    // 只说“清单已交给它”：我们只知道命令被接受，不知道里面的 pi 是否跑起来了。
    ctx.ui.notify(
      `next-steps: 已开${target.label}·${outcome.detail}，${items.length} 条任务清单已交给它${jump}`,
      "info",
    );
    return true;
  }

  /** 探一遍所有入口：列出能用的，同时收集不能用的原因。 */
  private async availableTargets(
    sessionFile: string | undefined,
  ): Promise<{ targets: SpawnTarget[]; reasons: string[] }> {
    const probes: Record<SpawnProvider, () => Promise<ProbeResult>> = {
      otty: () => probeOtty(this.pi, sessionFile),
      tmux: () => probeTmux(this.pi),
      zellij: async () => probeZellij(),
      wezterm: async () => probeWezterm(),
      ghostty: () => probeGhostty(this.pi),
    };
    const targets: SpawnTarget[] = [];
    const reasons: string[] = [];
    for (const provider of PROVIDER_ORDER) {
      const result = await probes[provider]();
      if (result.target) targets.push(result.target);
      else reasons.push(`${provider} ${result.reason}`);
    }
    return { targets, reasons };
  }

  /** `/next focus [n]`：把第 n 个最近派发的窗格拉到眼前。 */
  async focusRecent(ctx: ExtensionContext, index: number): Promise<void> {
    const record = this.recent[index - 1];
    if (!record) {
      ctx.ui.notify(
        this.recent.length === 0
          ? "next-steps: 这个会话还没派发过任务"
          : `next-steps: 只有 ${this.recent.length} 条派发记录`,
        "warning",
      );
      return;
    }
    const outcome = await focusSpawn(this.pi, record);
    ctx.ui.notify(
      outcome.ok
        ? `next-steps: 已跳到 ${record.handle} · ${clip(record.title, 60)}`
        : `next-steps: 跳转失败：${outcome.detail}`,
      outcome.ok ? "info" : "error",
    );
  }

  /** /next：没有候选就先补生成，然后打开选择器。 */
  async showPicker(ctx: ExtensionContext, enterMode: SpawnMode = "edit"): Promise<void> {
    if (!ctx.hasUI) return;

    if (this.candidates.length === 0) {
      const tail = lastAssistantTail(ctx);
      if (!tail) {
        ctx.ui.notify("next-steps: 还没有可用的上文", "warning");
        return;
      }
      if (!(await this.generate(ctx, tail))) {
        ctx.ui.notify("next-steps: 这次没生成出候选", "warning");
        return;
      }
    }
    await this.ask(ctx, enterMode);
  }

  setAuto(ctx: ExtensionContext, enabled: boolean): void {
    this.autoEnabled = enabled;
    if (!enabled) {
      this.cancel();
      this.clear(ctx);
    }
    if (ctx.hasUI) {
      ctx.ui.notify(`next-steps: 自动建议已${enabled ? "开启" : "关闭"}`);
    }
  }

  private cancel(): void {
    this.abort?.abort();
    this.abort = null;
    this.generationId += 1;
    this.candidates = [];
  }

  private clear(ctx: ExtensionContext): void {
    this.candidates = [];
    this.hideWidget(ctx);
  }

  /** 只收 widget，保留候选（/next 重开时要继续用）。 */
  private hideWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  private render(ctx: ExtensionContext, model: AnyModel): void {
    const theme = ctx.ui.theme;
    const header = `${BOLT_ICON} ${theme.fg("dim", `下一步 · 输入 /next 重新选择 · ${modelLabel(model)}`)}`;
    const lines = [
      header,
      ...this.candidates.map(
        (candidate, index) => `${theme.fg("accent", `${index + 1}`)} ${candidate}`,
      ),
    ];
    ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "aboveEditor" });
  }

  private warnOnce(
    ctx: ExtensionContext,
    model: AnyModel | undefined,
    detail: string,
  ): void {
    const scope = `${ctx.sessionManager.getSessionId()}:${model ? modelLabel(model) : "none"}`;
    if (this.warnedScope === scope) return;
    this.warnedScope = scope;
    if (ctx.hasUI) ctx.ui.notify(`next-steps: ${detail}`, "warning");
  }
}

export default function (pi: ExtensionAPI): void {
  const nextSteps = new NextSteps(pi);

  pi.registerFlag("next-model", {
    description: "跑下一步建议的模型，形如 provider/model-id",
    type: "string",
    default: "",
  });

  pi.on("session_start", (_event, ctx) => nextSteps.onSessionStart(ctx));
  pi.on("agent_start", (_event, ctx) => nextSteps.onAgentStart(ctx));
  pi.on("agent_settled", (event, ctx) => nextSteps.onAgentSettled(event, ctx));

  pi.registerCommand("next", {
    description:
      "下一步候选：空格多选，Enter 填入输入框（不发送），p 选终端后在新窗格独立执行；/next pane 以开窗格为默认，/next focus [n] 跳到最近派发的窗格，/next on|off 开关自动建议",
    handler: async (args, ctx) => {
      const [arg, extra] = (args ?? "").trim().toLowerCase().split(/\s+/);
      if (arg === "off") {
        nextSteps.setAuto(ctx, false);
        return;
      }
      if (arg === "on") {
        nextSteps.setAuto(ctx, true);
        return;
      }
      if (arg === "pane") {
        await nextSteps.showPicker(ctx, "pane");
        return;
      }
      if (arg === "focus") {
        const index = Number(extra);
        await nextSteps.focusRecent(
          ctx,
          Number.isFinite(index) && index > 0 ? index : 1,
        );
        return;
      }
      await nextSteps.showPicker(ctx);
    },
  });
}
