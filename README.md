# zumo

Phone mission control for Claude Code. zumo lets you launch, monitor, and control Claude sessions on your Linux machine from a mobile PWA over Tailscale.

It complements Claude Code Remote Control: Claude owns the chat experience; zumo owns the machine plane.

- Launch Claude in any scanned git repository.
- Browse transcript-backed Claude history and resume the exact native conversation.
- See which sessions are working, idle, or waiting for approval.
- Open the real tmux terminal with mobile-friendly control keys.
- Receive web-push alerts for `Notification` and `Stop` hooks.
- Keep timestamped terminal recordings for seven days, capped at 1 GB.

## Requirements

- macOS or Linux with Node.js 22.18+, Bun, tmux 3.1+, Claude Code, and curl
- Tailscale for private HTTPS access from the phone
- A modern mobile browser; iOS web push requires installation to the Home Screen

The daemon intentionally runs under Node. `node-pty` starts under Bun on this machine but drops PTY output; Node is the verified fallback from the approved design. Bun remains the package manager and test runner. (Node 22.18+ is required because the entrypoint is run as `node index.ts`.)

### Platform support

tmux is the session substrate and `node-pty` is the terminal bridge — both work on macOS and Linux, so the daemon itself is cross-platform. What differs is the process supervisor that `bun run setup` wires up.

- **Linux** — fully supported. `bun run setup` installs a **systemd** user service and a daily retention timer.
- **macOS** — the daemon runs, but `bun run setup` on macOS does not yet install a supervisor; run it manually with `bun run start`, register the Claude `Notification`/`Stop` hooks to `bin/zumo-hook.sh`, and schedule `bin/retention.js` yourself. (Automated launchd setup is planned.)
- **Windows** — there is no native tmux, so native Windows is **not supported**. Run zumo inside **WSL2**, where it behaves exactly like Linux.

## Install

```bash
bun install
bun run setup
```

Setup performs the local installation:

- creates `~/.zumo/config.json` and VAPID keys;
- registers fail-silent Claude `Notification` and `Stop` hooks;
- installs and starts the `zumo.service` user unit;
- installs the daily recording-retention timer.

Then expose the daemon only to your tailnet:

```bash
tailscale serve --bg 7323
```

Open the printed `https://…ts.net` URL on the phone, install it as a PWA, and tap **Enable alerts**. To keep the user service running after logout:

```bash
sudo loginctl enable-linger "$USER"
```

## Development

```bash
bun install
bun run dev
```

The local app is served at [http://127.0.0.1:7323](http://127.0.0.1:7323). Useful checks:

```bash
bun test
bun run check
```

Configuration lives at `~/.zumo/config.json`:

```json
{
  "port": 7323,
  "repoRoots": ["/home/you/my-work"],
  "activityWindowMs": 3000,
  "claudeBin": "/absolute/path/to/claude",
  "vapid": {
    "publicKey": "…",
    "privateKey": "…",
    "subject": "mailto:zumo@localhost"
  }
}
```

`ZUMO_HOME`, `ZUMO_PORT`, and `ZUMO_CLAUDE_BIN` can override the corresponding defaults for development or testing. If a legacy `~/.port23` directory exists and `~/.zumo` does not, zumo keeps using it, so upgrades from the former `port23` name need no migration.

## How it works

The daemon listens only on `127.0.0.1`. `tailscale serve` supplies the HTTPS/WSS boundary required by PWA installation and web push.

Each managed session is a tmux session named `p23-<repo>-<nnn>`. Launch requests are written to a mode-0600 pending file; prompts and flags never pass through a shell parser. A PTY-backed WebSocket attaches the phone to a short-lived grouped tmux session, while `pipe-pane` writes timestamped base64 chunks to `~/.zumo/recordings/<session>.jsonl`.

The **History** tab reads Claude's local `~/.claude/history.jsonl`, keeps only sessions with an existing transcript, and resumes with the original Claude UUID. Work continued on the phone therefore remains available through `claude --resume` on the laptop.

The tailnet is the authentication boundary. Do not bind the daemon to a public interface or expose it through a public reverse proxy.
