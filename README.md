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

Installing is three explicit steps — `add` never trusts or enables on its own:

```sh
jazz plugin add /path/to/jazz-plugin-warp   # verify + install a local manifest (no trust, no enable)
jazz plugin trust com.jazz.plugins.warp     # acknowledge OS-user code execution for this digest
jazz plugin enable com.jazz.plugins.warp --agent <id-or-name>   # enable for one agent
```

`jazz plugin inspect com.jazz.plugins.warp` shows the digest, declarations, and enablement. The
manifest is `jazz-plugin.json` (id `com.jazz.plugins.warp`, entry `src/index.ts`). This plugin
declares no network destinations, tools, or secrets — only the two lifecycle hooks.

## Develop

```sh
bun install
bun test
bun run typecheck
```

### The vendored SDK

`types/jazz-plugin-sdk.ts` is a local copy of Jazz's types-only `@jazz/plugin-sdk` ABI, mapped in
`tsconfig.json`. The plugin imports it with `import type` only — all runtime capabilities are passed
to `register(api)` by the host — so the vendored copy is used at type-check time and never bundled.
Replace it with the published package once `@jazz/plugin-sdk` is on npm.

## License

MIT
