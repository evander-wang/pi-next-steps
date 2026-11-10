# Changelog

## [0.1.0] - 2026-11-10

- Initial extraction from a personal `~/.pi/agent/extensions` setup.
- Multi-select next-step candidates; `Enter` fills the editor, `p` dispatches.
- Dispatch writes a handoff file + runner script and opens a real pane in the
  current tab: Otty, tmux, zellij, wezterm, or Ghostty (via AppleScript split).
- `/next focus [n]` jumps back to a previously dispatched pane; Otty deeplinks
  (`otty://pane/<id>`) are included in the success toast.
- Runner resolves an absolute `pi` path and copies pi's `PATH`, so spawns work
  from a fresh login shell.
