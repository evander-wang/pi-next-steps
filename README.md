# pi-next-steps

A [Pi](https://pi.dev) extension: after every turn it proposes up to 3 concrete
"next steps". Press Enter to drop one into the editor, or hand any 1–N of them
to a **fresh agent in a new pane** with full context forked from the current
session.

Nothing is ever executed automatically — dispatching a task is always an
explicit keypress.

## Install

```bash
pi install git:github.com/<you>/pi-next-steps
```

Then `/reload` (or restart pi).

## Usage

After the agent finishes a turn, a multi-select picker appears:

| Key | Action |
| --- | --- |
| `space` | toggle the highlighted candidate |
| `↑` `↓` / `k` `j` | move |
| `Enter` | put the picked candidates into the editor (**never sends**) |
| `p` | dispatch the picked candidates to a new pane (asks where, then confirms) |
| `Esc` | close, keep the candidates |

Commands:

| Command | Action |
| --- | --- |
| `/next` | reopen the picker for the current candidates |
| `/next pane` | reopen it with `Enter` meaning "dispatch", not "fill the editor" |
| `/next focus [n]` | jump to the n-th most recently dispatched pane (`/next focus` = the latest) |
| `/next on` / `/next off` | enable / disable the automatic suggestions |

Clicking through: the success toast carries the pane's `otty://pane/<id>`
deeplink; `/next focus` is the keyboard equivalent.

## What "dispatch" does

1. The checked candidates (1–N) are written to a handoff file:
   `$TMPDIR/pi-next-handoff/<timestamp>-<pid>.md`
2. A runner script is written next to it, which execs
   `pi --fork <session.jsonl> @<handoff.md>` — so the new agent has the full
   conversation, in an **independent session**.
3. The runner is launched in a **new pane inside the current tab** of whichever
   terminal you pick.

Panes are real panes, not windows:

| Terminal | Mechanism | Platform |
| --- | --- | --- |
| Otty | `otty-cli pane split` (IPC) | macOS |
| tmux | `tmux split-window` | any |
| zellij | `zellij action new-pane` | any |
| wezterm | `wezterm cli split-pane` | any |
| Ghostty | AppleScript `split` via `Ghostty.sdef` (the CLI has no split action) | macOS |

Only terminals that are actually available are offered.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `PI_BIN` | `~/.pi/agent/bin/pi`, else `pi` on `PATH` | binary the runner executes |
| `OTTY_CLI` | `/Applications/Otty.app/Contents/MacOS/otty-cli` | Otty control CLI |
| `GHOSTTY_APP` | `/Applications/Ghostty.app` | Ghostty bundle (AppleScript target) |
| `PI_NEXT_STEPS_MODEL` | cheapest authenticated model | model that generates the candidates |

CLI flag `--next-model provider/model-id` overrides `PI_NEXT_STEPS_MODEL`.

All of these are read **once, when the extension module loads** — change the
environment and `/reload`.

## Notes and limitations

- The runner script hard-codes the absolute `pi` path and copies pi's own `PATH`
  into itself. A bare `pi` would fail in a fresh login shell (`exec: pi: not
  found`), because the managed `pi` is a shell wrapper that also needs `node` on
  `PATH`.
- Ghostty needs macOS automation permission once
  (System Settings → Privacy & Security → Automation). A `-1743` failure is
  reported with that hint.
- There is **no readiness probe**: the toast says the task list was handed over,
  not that the new agent booted. The pane is in front of you; if the launch
  fails, the runner prints the reason in that pane.
- Written against Pi 1.5.x extension APIs (`ctx.ui.custom`, `ctx.ui.select`,
  `ctx.modelRegistry.streamSimple`, `ctx.sessionManager`).

## Tests

```bash
cd tests && bun test
```

`tests/setup.ts` is a bun preload that points `@earendil-works/pi-tui` at the
real implementation inside the current Pi install (resolved through
`PI_MANAGED_INSTALL_ROOT` or `~/.pi/agent/install/current-version`), because the
extension directory has no `node_modules` of its own. Without a local Pi install
these tests cannot resolve their imports.
