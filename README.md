# jazz-plugin-warp

A [Jazz](https://github.com/lvndry/jazz) plugin that raises a native desktop notification when the
agent finishes a task or is waiting for your next message. It rides Jazz's lifecycle-hook system —
the same shape as [`warpdotdev/claude-code-warp`](https://github.com/warpdotdev/claude-code-warp),
which rides Claude Code's hook system.

## What it does

The plugin subscribes to two lifecycle events and shells out to the OS notifier:

- **`run-complete`** — "Jazz — task complete", with the response summary as the body.
- **`awaiting-input`** — "Jazz — waiting for you".

Delivery is best-effort: it is platform-guarded (`osascript` on macOS, `notify-send` on Linux) and
any failure is swallowed. Lifecycle handlers are fire-and-forget, so nothing here can delay or break
a run.

## Configuration

- Set `JAZZ_WARP_SILENT=1` to suppress all notifications (used in tests and headless runs).

## Install

Install straight from GitHub — no clone, no build, no `git` or `bun` required. Install, trust, and
enable are separate steps; `add` never trusts or enables on its own:

```sh
jazz plugin add lvndry/jazz-plugin-warp                # download + install (no trust, no enable)
jazz plugin trust com.jazz.plugins.warp                # acknowledge OS-user code execution for this digest
jazz plugin enable com.jazz.plugins.warp --agent <id-or-name>   # grant egress consent + enable for one agent
```

Pin a version with `jazz plugin add lvndry/jazz-plugin-warp@v0.1.0`. `jazz plugin inspect
com.jazz.plugins.warp` shows the digest, declarations, grants, and enablement. The manifest is
`jazz-plugin.json` (id `com.jazz.plugins.warp`, entry `src/index.ts`); this plugin declares no
network destinations, tools, or secrets — only the two lifecycle hooks.

## Develop

```sh
bun install
bun test
bun run typecheck
```

## License

MIT
