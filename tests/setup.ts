/**
 * bun test 预加载：把 @earendil-works/pi-tui 指到当前 pi 安装里的真实实现。
 *
 * 扩展是从 ~/.pi/agent/extensions 直接加载的，目录里没有 node_modules，
 * 所以裸跑 bun test 解析不到 pi-tui —— 这里用 mock.module 转发过去。
 */
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function piInstallRoot(): string {
  // PI_MANAGED_INSTALL_ROOT 指向 install 根目录（不是某个 release），
  // 具体版本还要读 current-version，不然升级后路径就断了。
  const base =
    process.env.PI_MANAGED_INSTALL_ROOT?.trim() ||
    join(homedir(), ".pi", "agent", "install");
  const version = readFileSync(join(base, "current-version"), "utf8").trim();
  return join(base, "releases", version);
}

const tui = join(
  piInstallRoot(),
  "node_modules",
  "@earendil-works",
  "pi-tui",
  "dist",
  "index.js",
);
const real = await import(tui);

mock.module("@earendil-works/pi-tui", () => ({
  matchesKey: real.matchesKey,
  truncateToWidth: real.truncateToWidth,
}));
