import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GHOSTTY_APP,
  OTTY_CLI,
  PROVIDER_ORDER,
  MultiSelectDialog,
  pickAnchor,
  probeGhostty,
  probeOtty,
  probeTmux,
  spawnVia,
  writeHandoff,
  writeRunner,
  describeNoTargets,
  asQuote,
  focusSpawn,
  labelOf,
  MAX_HANDOFFS,
  NextSteps,
  paneEntryLabel,
  pruneHandoffs,
  paneLink,
  piArgs,
  resolvePiBin,
  runtimePathDirs,
  type PaneRow,
  type PickerResult,
} from "../extensions/next-steps";

/** 临时改 PI_BIN，跑完一定还原（断言失败也不污染后面的用例）。 */
function withPiBin(value: string | undefined, run: () => void): void {
  const before = process.env.PI_BIN;
  if (value === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = before;
  }
}

/** 测试里 otty 用绝对路径常量作为 exec 的 command key。 */
const OTTY = OTTY_CLI;

// ---------------------------------------------------------------- 假的宿主

type ExecReply = { stdout?: string; stderr?: string; code?: number; throws?: string };

/** 记录每次 exec，并按命令回放预设结果。 */
function fakePi(replies: Record<string, ExecReply | (() => ExecReply)>) {
  const calls: { command: string; args: string[] }[] = [];
  const pi = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      const hit = replies[command];
      const reply = typeof hit === "function" ? hit() : hit ?? { code: 127, stderr: "not found" };
      if (reply.throws) throw new Error(reply.throws);
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: reply.code ?? 0,
        killed: false,
        truncated: false,
      };
    },
  };
  // 扩展只用到 exec 这一个 API，测试里按结构类型传进去即可。
  return { pi: pi as never, calls };
}

const PANES: PaneRow[] = [
  { id: "p_shell", active: true, cols: 160, rows: 80 },
  {
    id: "p_pi_a",
    active: false,
    cols: 160,
    agent: "Pi",
    agent_session_id: "2026-11-10T07-01-46-883Z_sess-a",
  },
  { id: "p_pi_wide", active: false, cols: 90, agent: "Pi", agent_session_id: "unrelated-session" },
];

const SESSION = "/home/u/.pi/agent/sessions/proj/2026-11-10T07-01-46-883Z_sess-a.jsonl";

function fakeCtx(sessionFile: string | undefined = SESSION, cwd = "/home/u/proj") {
  return {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => cwd,
    },
  } as never;
}

const theme = {
  fg: (_color: string, text: string) => text,
};

function dialog(items: string[], done: (result: PickerResult | undefined) => void, enterMode?: "edit" | "pane") {
  return new MultiSelectDialog(items, theme, done, enterMode);
}

// ---------------------------------------------------------------- 选择器

describe("MultiSelectDialog", () => {
  test("回车只回传选中项，mode 是 edit（不执行）", () => {
    let out: PickerResult | undefined;
    const d = dialog(["A", "B"], (r) => (out = r));
    d.handleInput(" ");
    d.handleInput("\r");
    expect(out).toEqual({ picked: ["A"], mode: "edit" });
  });

  test("按 p 走 pane 模式，且不改变回车语义", () => {
    let out: PickerResult | undefined;
    const d = dialog(["A", "B"], (r) => (out = r));
    d.handleInput("\u001b[B");
    d.handleInput("p");
    expect(out).toEqual({ picked: ["B"], mode: "pane" });
  });

  test("多选顺序跟列表顺序一致，不跟勾选先后", () => {
    let out: PickerResult | undefined;
    const d = dialog(["A", "B", "C"], (r) => (out = r));
    d.handleInput("\u001b[B");
    d.handleInput("\u001b[B");
    d.handleInput(" "); // C
    d.handleInput("\u001b[A");
    d.handleInput("\u001b[A");
    d.handleInput(" "); // A
    d.handleInput("p");
    expect(out).toEqual({ picked: ["A", "C"], mode: "pane" });
  });

  test("Esc 回传 undefined", () => {
    let out: PickerResult | undefined = { picked: ["x"], mode: "edit" };
    const d = dialog(["A"], (r) => (out = r));
    d.handleInput("\u001b");
    expect(out).toBeUndefined();
  });

  test("enterMode=pane 时回车就是派发，提示行也跟着换", () => {
    let out: PickerResult | undefined;
    const d = dialog(["A"], (r) => (out = r), "pane");
    d.handleInput("\r");
    expect(out).toEqual({ picked: ["A"], mode: "pane" });
    expect(d.render(80)[0]).toContain("Enter 在独立窗格执行");
  });

  test("一条没勾也用光标那条，保留单选肌肉记忆", () => {
    let out: PickerResult | undefined;
    const d = dialog(["A", "B"], (r) => (out = r));
    d.handleInput("\u001b[B");
    d.handleInput("\r");
    expect(out).toEqual({ picked: ["B"], mode: "edit" });
  });
});

// ---------------------------------------------------------------- 锚点

describe("pickAnchor", () => {
  test("优先用 $OTTY_PANE_ID", () => {
    process.env.OTTY_PANE_ID = "p_pi_wide";
    expect(pickAnchor(PANES, SESSION)?.id).toBe("p_pi_wide");
    delete process.env.OTTY_PANE_ID;
  });

  test("没有环境变量时按 session 文件匹配本会话所在 pane", () => {
    delete process.env.OTTY_PANE_ID;
    expect(pickAnchor(PANES, SESSION)?.id).toBe("p_pi_a");
  });

  test("都匹配不到退到当前焦点 pane", () => {
    delete process.env.OTTY_PANE_ID;
    expect(pickAnchor(PANES, "/tmp/other.jsonl")?.id).toBe("p_shell");
  });

  test("拿不到 pane 列表也没有环境变量就不猜", () => {
    delete process.env.OTTY_PANE_ID;
    expect(pickAnchor(undefined, SESSION)).toBeUndefined();
    expect(pickAnchor([], SESSION)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 探针

describe("终端探针", () => {
  test("otty 能应答时给出带 pane id 和列数的目标", async () => {
    process.env.OTTY_PANE_ID = "p_pi_a";
    const { pi } = fakePi({ [OTTY]: { stdout: JSON.stringify({ data: PANES }) } });
    const result = await probeOtty(pi, SESSION);
    delete process.env.OTTY_PANE_ID;
    expect(result.target?.provider).toBe("otty");
    expect(result.target?.ottyPane).toBe("p_pi_a");
    expect(result.target?.ottyCols).toBe(160);
    expect(result.target?.label).toContain("新窗格");
  });

  test("otty CLI 不可用时报出具体原因", async () => {
    const { pi } = fakePi({ [OTTY]: { code: 3, stderr: "socket gone" } });
    const result = await probeOtty(pi, SESSION);
    expect(result.target).toBeUndefined();
    expect(result.reason).toContain("socket");
  });

  test("tmux 无部署时报出 stderr 摘要", async () => {
    delete process.env.TMUX;
    const { pi } = fakePi({ tmux: { code: 1, stderr: "no server running" } });
    const result = await probeTmux(pi);
    expect(result.target).toBeUndefined();
    expect(result.reason).toContain("no server running");
  });

  test("tmux 有挂着的客户端时投到那个会话", async () => {
    delete process.env.TMUX;
    const { pi } = fakePi({ tmux: { stdout: "main\nscratch\n" } });
    const result = await probeTmux(pi);
    expect(result.target?.tmuxTarget).toBe("main");
    expect(result.target?.label).toContain("会话 main");
  });

  test("不在 zellij / wezterm 里就不给目标", async () => {
    const { pi } = fakePi({});
    expect((await probeTmux(pi)).target).toBeUndefined();
  });

  test("ghostty 走 AppleScript split，文案是当前 tab 的新窗格", async () => {
    const { pi } = fakePi({ osascript: { stdout: "1\n" } });
    const result = await probeGhostty(pi);
    if (process.platform === "darwin" && existsSync(GHOSTTY_APP)) {
      expect(result.target?.provider).toBe("ghostty");
      expect(result.target?.label).toContain("新窗格");
      expect(result.target?.label).toContain("当前 tab");
    } else {
      expect(result.reason).toBeTruthy();
    }
  });

  test("ghostty 没有窗口时不提供入口", async () => {
    const { pi } = fakePi({ osascript: { stdout: "0\n" } });
    const result = await probeGhostty(pi);
    if (process.platform === "darwin" && existsSync(GHOSTTY_APP)) {
      expect(result.target).toBeUndefined();
      expect(result.reason).toContain("没有窗口");
    }
  });

  test("ghostty AppleScript 被拒时把权限提示带上", async () => {
    const { pi } = fakePi({ osascript: { code: 1, stderr: "execution error: -1743" } });
    const result = await probeGhostty(pi);
    if (process.platform === "darwin" && existsSync(GHOSTTY_APP)) {
      expect(result.target).toBeUndefined();
      expect(result.reason).toContain("AppleScript");
    }
  });
});

// ---------------------------------------------------------------- 落盘

describe("handoff 与 runner", () => {
  test("handoff 带 front-matter 和编号清单", async () => {
    const file = await writeHandoff(fakeCtx(), ["第一条", "第二条", "第三条"], true);
    const text = await readFile(file, "utf8");
    expect(text).toContain(`from: ${SESSION}`);
    expect(text).toContain("cwd: /home/u/proj");
    expect(text).toContain("items: 3");
    expect(text).toContain("context: fork");
    expect(text).toContain("1. 第一条");
    expect(text).toContain("3. 第三条");
    // fork 时不该再让新会话复述历史
    expect(text).toContain("不需要复述");
    expect(text).toContain("三条以上");
    await rm(file, { force: true });
  });

  test("没有 session 文件时标记为 clean 并去掉复述提示", async () => {
    const file = await writeHandoff(fakeCtx(undefined), ["就一条"], false);
    const text = await readFile(file, "utf8");
    expect(text).toContain("context: clean");
    expect(text).not.toContain("不需要复述");
    expect(text).not.toContain("三条以上");
    await rm(file, { force: true });
  });

  test("runner 用绝对路径，不靠 PATH", async () => {
    const handoff = await writeHandoff(fakeCtx(), ["做点事"], true);
    const script = await writeRunner(SESSION, handoff);
    const text = await readFile(script, "utf8");
    const bin = resolvePiBin();
    // 关键：脚本里出现的是解析好的绝对路径，而不是裸 pi 等 PATH 解析
    expect(text).toContain(`PI_BIN='${bin}'`);
    expect(text).toContain('exec "$PI_BIN"');
    expect(text).not.toMatch(/^exec '?pi'? /m);
    expect(text).toContain("找不到 pi 可执行文件");
    // 托管 pi 是个 sh 包装脚本，还得靠 PATH 找 node
    expect(text).toContain('PATH=');
    expect(text).toContain("export PATH");
    for (const dir of runtimePathDirs()) expect(text).toContain(dir);
    // 干净 PATH 下也真的能跑：只 lint 语法，不真跑 pi
    const sh = Bun.spawnSync(["/bin/sh", "-n", script]);
    expect(sh.exitCode).toBe(0);
    await rm(handoff, { force: true });
    await rm(script, { force: true });
  });

  test("resolvePiBin 优先级：PI_BIN > 托管 bin", () => {
    withPiBin("/opt/x/pi", () => {
      expect(resolvePiBin()).toBe("/opt/x/pi");
    });
    withPiBin(undefined, () => {
      // 本机有托管 pi 时是绝对路径，没有（例如 CI）就退化成 PATH 查找的 "pi"
      const bin = resolvePiBin();
      expect(bin === "pi" || bin.endsWith("/pi")).toBe(true);
    });
  });

  test("PI_BIN 指向不存在的路径也照用，不静默回退到托管 bin", () => {
    // 显式覆盖是"我就要这个"：路径错了要在 runner 里报出来，
    // 而不是悄悄换一个 pi 去跑别人的任务。
    withPiBin("/nonexistent/definitely-not-pi", () => {
      expect(resolvePiBin()).toBe("/nonexistent/definitely-not-pi");
    });
  });

  test("PI_BIN 只有空白时按未设置处理，回落到托管 bin", () => {
    const managed = join(homedir(), ".pi", "agent", "bin", "pi");
    // 回落后可能是托管路径，也可能（没有托管 pi 的环境，如 CI）退化成 PATH 查找的 "pi"
    const isPi = (bin: string) => bin === "pi" || bin.endsWith("/pi");
    withPiBin("   ", () => {
      const bin = resolvePiBin();
      expect(bin.trim()).not.toBe("");
      expect(isPi(bin)).toBe(true);
    });
    withPiBin("", () => {
      expect(isPi(resolvePiBin())).toBe(true);
    });
    if (existsSync(managed)) {
      withPiBin("  \t ", () => {
        expect(resolvePiBin()).toBe(managed);
      });
    }
  });

  test("piArgs 只拼参数，不含二进制", () => {
    expect(piArgs(SESSION, "/tmp/h.md")).toBe(`--fork '${SESSION}' @'/tmp/h.md'`);
    expect(piArgs(undefined, "/tmp/h.md")).toBe("@'/tmp/h.md'");
  });

  test("runner 可执行、带 --fork 和 @handoff", async () => {
    const handoff = await writeHandoff(fakeCtx(), ["做点事"], true);
    const script = await writeRunner(SESSION, handoff);
    const text = await readFile(script, "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toContain(`--fork '${SESSION}'`);
    expect(text).toContain(`@'${handoff}'`);
    expect(text).toContain("exec ");
    const mode = (await stat(script)).mode & 0o777;
    expect(mode).toBe(0o755);
    await rm(handoff, { force: true });
    await rm(script, { force: true });
  });
});

// ---------------------------------------------------------------- 文案与转义

describe("labelOf / asQuote", () => {
  test("所有入口都说新窗格（ghostty 也是 split，不是新窗口）", () => {
    for (const provider of PROVIDER_ORDER) {
      const label = labelOf(provider, "x");
      expect(label).toContain("新窗格");
      expect(label).not.toContain("新窗口");
    }
  });

  test("asQuote 转义反斜杠和双引号", () => {
    expect(asQuote('/tmp/a b.sh')).toBe('"/tmp/a b.sh"');
    expect(asQuote('a"b')).toBe('"a\\"b"');
    expect(asQuote("a\\b")).toBe('"a\\\\b"');
  });
});

// ---------------------------------------------------------------- 派发编排

describe("paneEntryLabel", () => {
  const rec = (over: Partial<Record<string, unknown>> = {}) =>
    ({ provider: "otty", handle: "p_1", title: "next: 修测试", items: ["a"], ...over }) as never;

  test("带上序号、provider、窗格 id 和标题", () => {
    expect(paneEntryLabel(rec(), 1)).toBe("1. otty · p_1 · next: 修测试");
  });

  test("超长标题截断到 48 字内", () => {
    const long = "x".repeat(200);
    const label = paneEntryLabel(rec({ title: long }), 2);
    expect(label.startsWith("2. otty · p_1 · ")).toBe(true);
    expect(label.length).toBeLessThan(70);
    expect(label).toContain("\u2026");
  });
});

describe("派发互斥", () => {
  /** 把 confirm 卡住，模拟「select / confirm 那段几秒的窗口期」。 */
  function stuckCtx(notices: string[]) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = {
      hasUI: true,
      mode: "tui",
      sessionManager: { getCwd: () => "/p", getSessionFile: () => undefined },
      ui: {
        getEditorText: () => "",
        notify: (message: string) => notices.push(message),
        select: async () => undefined,
        confirm: async () => {
          await gate;
          return false;
        },
      },
    } as never;
    return { ctx, release: () => release() };
  }

  test("第一次还没结束时，第二次直接被拒掉", async () => {
    process.env.TMUX = "/tmp/fake-tmux";   // 让 probeTmux 直接给出目标，不 exec
    const notices: string[] = [];
    const { ctx, release } = stuckCtx(notices);
    const steps = new NextSteps(fakePi({}).pi);
    const dispatch = steps as unknown as {
      dispatchToPane(c: unknown, items: string[]): Promise<boolean>;
    };

    const first = dispatch.dispatchToPane(ctx, ["a"]);
    await new Promise((r) => setTimeout(r, 10));      // 让它进入 confirm 并卡住
    expect(await dispatch.dispatchToPane(ctx, ["b"])).toBe(false);
    expect(notices.some((m) => m.includes("上一次派发还在进行"))).toBe(true);

    release();
    expect(await first).toBe(false);                   // confirm 返回 false，没派发
    delete process.env.TMUX;
  });

  test("上一次结束后又能派发了", async () => {
    process.env.TMUX = "/tmp/fake-tmux";
    const notices: string[] = [];
    const { ctx, release } = stuckCtx(notices);
    const steps = new NextSteps(fakePi({}).pi);
    const dispatch = steps as unknown as {
      dispatchToPane(c: unknown, items: string[]): Promise<boolean>;
    };

    const first = dispatch.dispatchToPane(ctx, ["a"]);
    release();
    await first;
    notices.length = 0;

    const second = dispatch.dispatchToPane(ctx, ["b"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(notices.some((m) => m.includes("上一次派发还在进行"))).toBe(false);
    release();
    await second;
    delete process.env.TMUX;
  });
});

// ---------------------------------------------------------------- ask 编排

describe("ask（选择器 → 结果处理）", () => {
  type Askable = { ask(ctx: unknown, mode?: string): Promise<void> };
  type Seedable = { candidates: string[]; model: unknown };

  const MODEL = { provider: "cheap", id: "flash" };

  /** 直接塞候选和模型，跳过真实的生成调用。 */
  function seeded(pi: ReturnType<typeof fakePi>["pi"], candidates: string[]) {
    const steps = new NextSteps(pi);
    const raw = steps as unknown as Seedable;
    raw.candidates = [...candidates];
    raw.model = MODEL;
    return { steps, ask: () => (steps as unknown as Askable).ask };
  }

  /** 假 ctx：custom 返回预设结果，其余只记录调用。 */
  function makeCtx(opts: {
    pick?: unknown;
    editorText?: string;
    confirm?: boolean;
    hasUI?: boolean;
  }) {
    const got = { editorText: [] as string[], widgets: [] as (string | undefined)[], notices: [] as string[] };
    const ctx = {
      hasUI: opts.hasUI ?? true,
      mode: "tui",
      sessionManager: {
        getCwd: () => "/p",
        getSessionFile: () => undefined,
        getSessionId: () => "s1",
        getBranch: () => [], // 没有上文 → lastAssistantTail 返回 null
      },
      ui: {
        theme: { fg: (_c: string, text: string) => text },
        getEditorText: () => opts.editorText ?? "",
        setEditorText: (text: string) => got.editorText.push(text),
        setWidget: (_key: string, content?: unknown) =>
          got.widgets.push(content as string | undefined),
        custom: async () => opts.pick,
        notify: (message: string) => got.notices.push(message),
        select: async () => undefined,
        confirm: async () => opts.confirm ?? true,
      },
    } as never;
    return { ctx, got };
  }

  test("回车：拼成多行填进编辑器，候选清空", async () => {
    const { pi } = fakePi({});
    const { steps } = seeded(pi, ["A", "B"]);
    const { ctx, got } = makeCtx({ pick: { picked: ["A", "B"], mode: "edit" } });

    await (steps as unknown as Askable).ask(ctx);

    expect(got.editorText).toEqual(["A\nB"]);
    expect((steps as unknown as Seedable).candidates).toEqual([]);
  });

  test("Esc：不填编辑器，候选保留并重画 widget", async () => {
    const { pi } = fakePi({});
    const { steps } = seeded(pi, ["A"]);
    const { ctx, got } = makeCtx({ pick: undefined });

    await (steps as unknown as Askable).ask(ctx);

    expect(got.editorText).toEqual([]);
    expect((steps as unknown as Seedable).candidates).toEqual(["A"]);
    // widget 内容是多行数组：拼起来看里面确实有常驻列表（带模型名）和候选
    const widget = (got.widgets.at(-1) as unknown as string[] | undefined)?.join("\n") ?? "";
    expect(widget).toContain("cheap/flash");
    expect(widget).toContain("A");
  });

  test("派发成功：只把派出去的那条从候选里去掉，剩下的重画", async () => {
    process.env.TMUX = "/tmp/fake-tmux";
    const { pi } = fakePi({ tmux: { stdout: "" } });
    const { steps } = seeded(pi, ["A", "B"]);
    const { ctx, got } = makeCtx({ pick: { picked: ["A"], mode: "pane" } });

    await (steps as unknown as Askable).ask(ctx);

    expect(got.editorText).toEqual([]);
    expect((steps as unknown as Seedable).candidates).toEqual(["B"]);
    delete process.env.TMUX;
  });

  test("派发失败：候选一条都不删", async () => {
    process.env.TMUX = "/tmp/fake-tmux";
    const { pi } = fakePi({ tmux: { stdout: "" } });
    const { steps } = seeded(pi, ["A", "B"]);
    const { ctx } = makeCtx({ pick: { picked: ["A"], mode: "pane" }, confirm: false });

    await (steps as unknown as Askable).ask(ctx);

    expect((steps as unknown as Seedable).candidates).toEqual(["A", "B"]);
    delete process.env.TMUX;
  });

  test("全部派出去后候选和 widget 都收掉", async () => {
    process.env.TMUX = "/tmp/fake-tmux";
    const { pi } = fakePi({ tmux: { stdout: "" } });
    const { steps } = seeded(pi, ["A"]);
    const { ctx, got } = makeCtx({ pick: { picked: ["A"], mode: "pane" } });

    await (steps as unknown as Askable).ask(ctx);

    expect((steps as unknown as Seedable).candidates).toEqual([]);
    expect(got.widgets.at(-1)).toBeUndefined(); // hideWidget
    delete process.env.TMUX;
  });

  test("已经有人在输入框里打字：不弹选择器", async () => {
    const { pi } = fakePi({});
    const { steps } = seeded(pi, ["A"]);
    const { ctx, got } = makeCtx({ pick: { picked: ["A"], mode: "edit" }, editorText: "打字中" });

    await (steps as unknown as Askable).ask(ctx);

    expect(got.editorText).toEqual([]);
    expect((steps as unknown as Seedable).candidates).toEqual(["A"]);
  });

  test("没有 UI 直接返回", async () => {
    const { pi } = fakePi({});
    const { steps } = seeded(pi, ["A"]);
    const { ctx, got } = makeCtx({ pick: { picked: ["A"], mode: "edit" }, hasUI: false });

    await (steps as unknown as Askable).ask(ctx);

    expect(got.editorText).toEqual([]);
  });

  test("选中「重新生成」但拿不到上文：安全返回，不炸", async () => {
    const { pi } = fakePi({});
    const { steps } = seeded(pi, ["A"]);
    const { ctx, got } = makeCtx({ pick: { picked: ["↻ 重新生成"], mode: "edit" } });

    await (steps as unknown as Askable).ask(ctx);

    expect(got.editorText).toEqual([]);
    expect((steps as unknown as Seedable).candidates).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------- 临时目录清理

describe("pruneHandoffs", () => {
  /** 造 n 次派发对应的文件对（.md + .sh）。 */
  async function seed(dir: string, n: number): Promise<string[]> {
    const bases: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const base = `2026-11-10T00-00-${String(i).padStart(2, "0")}-000Z-1000`;
      await writeFile(join(dir, `${base}.md`), "x", "utf8");
      await writeFile(join(dir, `${base}.sh`), "x", "utf8");
      bases.push(base);
    }
    return bases;
  }

  const tmp = () => mkdtemp(join(tmpdir(), "ns-prune-"));

  test("超过 keep 时只留最新的，最老的连 .md/.sh 一起删", async () => {
    const dir = await tmp();
    const bases = await seed(dir, 25);
    expect(await pruneHandoffs(20, dir)).toBe(10); // 5 次 × 2 个文件
    const left = (await readdir(dir)).sort();
    expect(left).toHaveLength(40);
    expect(left[0]).toBe(`${bases[5]}.md`);
    expect(left).not.toContain(`${bases[4]}.md`);
    await rm(dir, { recursive: true, force: true });
  });

  test("没超过 keep 就一个都不删", async () => {
    const dir = await tmp();
    await seed(dir, MAX_HANDOFFS);
    expect(await pruneHandoffs(MAX_HANDOFFS, dir)).toBe(0);
    expect(await readdir(dir)).toHaveLength(MAX_HANDOFFS * 2);
    await rm(dir, { recursive: true, force: true });
  });

  test("目录不存在时返回 0，不抛", async () => {
    expect(await pruneHandoffs(20, "/tmp/definitely-not-a-dir-ns")).toBe(0);
  });

  test("无关文件不碰", async () => {
    const dir = await tmp();
    await seed(dir, 22);
    await writeFile(join(dir, "notes.txt"), "keep me", "utf8");
    await pruneHandoffs(2, dir);
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("keep me");
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 跳转

describe("paneLink / focusSpawn", () => {
  const record = (provider: string, handle: string, link?: string) =>
    ({ provider, handle, link, title: "t", items: [] }) as never;

  test("otty deeplink 取得到就用它", async () => {
    const { pi } = fakePi({
      [OTTY]: { stdout: JSON.stringify({ data: { url: "otty://pane/p_1" } }) },
    });
    expect(await paneLink(pi, "p_1")).toBe("otty://pane/p_1");
  });

  test("deeplink 取不到不影响主流程", async () => {
    const { pi } = fakePi({ [OTTY]: { code: 1, stderr: "gone" } });
    expect(await paneLink(pi, "p_1")).toBeUndefined();
  });

  test("otty focus 用 link 优先", async () => {
    const { pi, calls } = fakePi({ [OTTY]: { stdout: "{}" } });
    const outcome = await focusSpawn(pi, record("otty", "p_1", "otty://pane/p_1"));
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args).toContain("otty://pane/p_1");
  });

  test("ghostty focus 找不到窗格时报清楚", async () => {
    const { pi } = fakePi({ osascript: { stdout: "false\n" } });
    const outcome = await focusSpawn(pi, record("ghostty", "T-1"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("已经不在了");
  });

  test("没有跳转入口的 provider 明确说不行", async () => {
    const { pi } = fakePi({});
    const outcome = await focusSpawn(pi, record("tmux", ""));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("没有跳转入口");
  });
});

// ---------------------------------------------------------------- 就绪探测

// ---------------------------------------------------------------- 报错文案

describe("失败提示", () => {
  test("一个入口都没有时逐个列出原因，并给出 handoff 路径", () => {
    const text = describeNoTargets(
      ["otty 控制 socket 没响应", "tmux 无部署", "ghostty 没装 Ghostty.app"],
      "/tmp/pi-next-handoff/2026-11-10-x.md",
    );
    expect(text).toContain("没有可用终端入口");
    expect(text).toContain("otty 控制 socket 没响应");
    expect(text).toContain("tmux 无部署");
    expect(text).toContain("/tmp/pi-next-handoff/2026-11-10-x.md");
    expect(text).not.toContain("\n");
  });

  test("host 也写不进文件时不带尾巴，不留空括号", () => {
    const text = describeNoTargets(["otty 没响应"], "");
    expect(text).toContain("没有可用终端入口（otty 没响应）");
    expect(text.endsWith("）")).toBe(true);
  });

  test("原因清单为空也有兜底文案", () => {
    expect(describeNoTargets([], "")).toContain("没有探测到任何终端");
  });
});

// ---------------------------------------------------------------- 派发失败

describe("spawnVia 失败路径", () => {
  const target = (provider: string, extra: Record<string, unknown> = {}) =>
    ({ provider, label: `${provider} · 新窗格`, ...extra }) as never;

  test("tmux 非零退出：带退出码和 stderr", async () => {
    const { pi } = fakePi({ tmux: { code: 1, stderr: "no current client" } });
    const outcome = await spawnVia(pi, target("tmux"), "/p", "/p/run.sh", "t");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("exit 1");
      expect(outcome.detail).toContain("no current client");
    }
  });

  test("otty 返回结构化错误：报错码优先于原文", async () => {
    const { pi } = fakePi({
      [OTTY]: {
        code: 2,
        stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane p_x closed" } }),
      },
    });
    const outcome = await spawnVia(
      pi,
      target("otty", { ottyPane: "p_x", ottyCols: 160 }),
      "/p",
      "/p/run.sh",
      "t",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("pane_not_found");
  });

  test("exec 自己抛异常也变成可读失败，不外泄", async () => {
    const { pi } = fakePi({ zellij: { throws: "spawn zellij ENOENT" } });
    const outcome = await spawnVia(pi, target("zellij"), "/p", "/p/run.sh", "t");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("ENOENT");
  });

  test("成功时回传落地标识", async () => {
    const { pi, calls } = fakePi({ tmux: { stdout: "" } });
    const outcome = await spawnVia(pi, target("tmux"), "/p", "/p/run.sh", "t");
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.args).toContain("/p/run.sh");
  });
});
