/**
 * bun test 预加载：把 @earendil-works/pi-tui 指到真实实现。
 *
 * 两种来源，按顺序尝试：
 *   1. 仓库自己的 node_modules（`bun install` 装过 devDependencies，CI 走这条）
 *   2. 本机 pi 安装里的副本（只有源码、没装依赖时走这条）
 *
 * 两条都不通就明确报错，不要静默用假实现 —— 那样测试会「通过」但什么也没验证。
 */
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type TuiModule = { matchesKey: unknown; truncateToWidth: unknown };

/** 本机 pi 安装目录（安装根目录 + current-version）。 */
function piInstallRoot(): string {
  const base =
    process.env.PI_MANAGED_INSTALL_ROOT?.trim() ||
    join(homedir(), ".pi", "agent", "install");
  const version = readFileSync(join(base, "current-version"), "utf8").trim();
  return join(base, "releases", version);
}

async function loadTui(): Promise<TuiModule> {
  // 1. 正常模块解析（仓库 node_modules）
  try {
    return (await import("@earendil-works/pi-tui")) as TuiModule;
  } catch {
    // 继续尝试本机 pi 安装
  }

  // 2. 本机 pi 安装里的真实实现
  let fallback = "";
  try {
    fallback = join(
      piInstallRoot(),
      "node_modules",
      "@earendil-works",
      "pi-tui",
      "dist",
      "index.js",
    );
    return (await import(fallback)) as TuiModule;
  } catch (error) {
    throw new Error(
      [
        "无法加载 @earendil-works/pi-tui，测试无法运行。",
        "  · 在仓库根执行 `bun install`（会装 devDependencies），或",
        "  · 保证本机装了 pi（默认路径 ~/.pi/agent/install，可用 PI_MANAGED_INSTALL_ROOT 覆盖）",
        fallback ? `  尝试过的路径：${fallback}` : "",
        `  原因：${error instanceof Error ? error.message : String(error)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

const real = await loadTui();

mock.module("@earendil-works/pi-tui", () => ({
  matchesKey: real.matchesKey,
  truncateToWidth: real.truncateToWidth,
}));
