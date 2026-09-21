# jazz-plugin-warp

A [Jazz](https://github.com/lvndry/jazz) plugin that raises a notification — bound to the exact Warp
tab the agent is running in — when it finishes a task or is waiting for your next message. It rides
Jazz's lifecycle-hook system, the same shape as
[`warpdotdev/claude-code-warp`](https://github.com/warpdotdev/claude-code-warp).

## What it does

The plugin subscribes to two lifecycle events:

- **`run-complete`** — "Jazz — task complete", with the response summary as the body.
- **`awaiting-input`** — "Jazz — waiting for you".

**Under Warp**, it emits an OSC 777 escape sequence — `\e]777;notify;warp://cli-agent;<json>\a` —
to the terminal. Because the sequence travels down the running tab's byte stream, Warp binds the
notification to that exact tab, and the JSON payload carries the session id, working directory, and
project so Warp can drive its session UI. It negotiates the `warp://cli-agent` protocol version and
falls back to a plain OSC notification on older Warp builds.

It sends the sequence through the host's `writeTerminalSequence` (the lifecycle handler context), so
it reaches the terminal even though Jazz's fullscreen UI owns stdout; on an older Jazz that doesn't
provide it, the plugin writes the controlling terminal (`/dev/tty`) itself.

**Off Warp**, it falls back to a native desktop notification (`osascript` on macOS, `notify-send` on
Linux).

Everything is best-effort and fire-and-forget: failures are swallowed, so nothing here can delay or
break a run.

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
