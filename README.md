# jazz-plugin-warp

A [Jazz](https://github.com/lvndry/jazz) plugin that raises normal native OS notifications when a
task finishes or is waiting for your next message. It rides Jazz's lifecycle-hook system.

## What it does

The plugin subscribes to two lifecycle events:

- **`run-complete`** — "Jazz — task complete", with the response summary as the body.
- **`awaiting-input`** — "Jazz — waiting for you", with the preceding response excerpt as the body.
  The excerpt is capped at 200 characters; the generic waiting message is used when no response is
  available.

The plugin uses Warp's documented generic OSC 777 notification format. Warp receives the title and
body, then delivers the notification through Warp's own desktop-notification settings on macOS,
Linux, or Windows. No AppleScript, `terminal-notifier`, or fake allowlisted agent identity is used.

This is the generic Warp notification path, not the richer `warp://cli-agent` session protocol. The
latter is reserved for agents Warp explicitly recognizes; Jazz uses the generic path until Warp adds
first-class Jazz support.

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
