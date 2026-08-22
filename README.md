# zumo

Mobile mission control for coding agents. Zumo runs on your workstation and gives your phone one inbox for Claude Code, Codex, OpenCode, and Pi without replacing their models, tools, authentication, or native CLI sessions.

## What works

- Launch any installed supported agent in a scanned git repository.
- Open local Claude sessions in Anthropic's official web or mobile UI through Remote Control.
- Use the stable structured Codex view for streamed messages, commands, file changes, diffs, questions, and approval buttons.
- Use the native PTY view for Claude Code, OpenCode, Pi, or raw Codex.
- Answer Codex questions, allow or deny commands, stop work, and dismiss completed/failed work from one action inbox.
- Hand work to another installed harness with the current branch/status/diff, or start a read-only Claude/Codex review.
- Browse transcript-backed Claude history and resume the exact native conversation.
- Attach images, use mobile terminal keys, and receive web-push alerts.
- Keep timestamped terminal recordings for seven days (1 GB cap) and uploaded images for 24 hours (256 MB cap).
- Optionally deploy a small AWS action relay for approvals and status away from the tailnet.

Zumo deliberately does not build another agent loop or proxy model APIs. The harnesses continue to own execution; Zumo owns sessions, attention, handoffs, and intervention.

Claude launches enable Remote Control by default and appear at `https://claude.ai/code` under their Zumo session name. Disable the launch toggle when using API-key, Bedrock, Vertex, or Foundry authentication; those modes do not support Remote Control. The private PTY terminal remains available as a fallback.

## Requirements

- macOS or Linux with Node.js 22.18+, Bun, tmux 3.1+, curl, and at least one supported agent
- Tailscale for the full private terminal PWA
- A modern mobile browser; iOS web push requires installing the PWA to the Home Screen
- Optional AWS CLI credentials and CloudFormation permissions for the managed action relay

Windows is supported through WSL2. Native Windows is not supported because the session substrate is tmux.

## Install

```bash
bun install
bun run setup
tailscale serve --bg 7323
```

Setup creates `~/.zumo/config.json`, detects agent binaries, installs fail-silent Claude hooks when available, and starts a user service plus the recording-retention job. Existing `~/.port23` installations remain in place for backward compatibility.

Open the `https://…ts.net` URL on your phone and install it as a PWA. On Linux, keep the user service alive after logout with:

```bash
sudo loginctl enable-linger "$USER"
```

The daemon runs under Node because `node-pty` is unreliable under Bun on the tested host. Bun remains the package manager and test runner.

### Services

- Linux: `zumo.service` and `zumo-retention.timer` under systemd user services
- macOS: `com.zumo.daemon` and `com.zumo.retention` under launchd

## Optional AWS action relay

The relay keeps the terminal private while making the small action inbox reachable from ordinary mobile internet:

```bash
aws sts get-caller-identity
bun run deploy:aws
systemctl --user restart zumo.service   # Linux
bun run smoke:relay
```

`deploy:aws` provisions API Gateway WebSocket, two arm64 Lambda functions, three encrypted on-demand DynamoDB tables, a private S3 bucket, CloudFront, 14-day logs, throttling, concurrency caps, and error alarms. It uploads the cloud PWA and writes the generated endpoint and device credential to the mode-0600 local config.

Open **Cloud pair** in the private Zumo PWA, then enter the 80-bit one-time code in the CloudFront client. Codes expire after five minutes. Pairing a new browser replaces the previous durable browser credential in this single-workstation release.

The AWS relay can see only:

- repository basename, harness, purpose, status, and timestamps;
- actionable approval/question/failure text, capped at 500 characters;
- allow, deny, answer, dismiss, refresh, and stop commands.

Source, paths, diffs, transcripts, prompts, terminal bytes, harness credentials, and model keys do not enter AWS. The full terminal remains available only through the local Tailscale PWA.

To deploy in another region:

```bash
bun run deploy:aws eu-west-1
```

## Development

```bash
bun install
bun run dev
bun test
bun run check
```

The local app is at [http://127.0.0.1:7323](http://127.0.0.1:7323). Useful operational checks:

```bash
systemctl --user status zumo.service
journalctl --user -u zumo.service -n 100
curl -fsS http://127.0.0.1:7323/api/relay
aws cloudformation describe-stacks --stack-name zumo-relay --region us-east-1
```

Configuration lives at `~/.zumo/config.json`:

```json
{
  "port": 7323,
  "repoRoots": ["/home/you/my-work"],
  "activityWindowMs": 3000,
  "agentBins": {
    "claude": "/absolute/path/to/claude",
    "codex": "/absolute/path/to/codex",
    "opencode": "/absolute/path/to/opencode",
    "pi": "/absolute/path/to/pi"
  }
}
```

`ZUMO_HOME`, `ZUMO_PORT`, `ZUMO_CLAUDE_BIN`, `ZUMO_CODEX_BIN`, `ZUMO_OPENCODE_BIN`, and `ZUMO_PI_BIN` override their defaults.

## Security model

The local daemon binds only to `127.0.0.1`; Tailscale is its identity and HTTPS boundary. State-changing browser requests and PTY WebSockets must be same-origin. Prompts and arguments are passed directly to child processes, never through a shell. Pairing codes and durable cloud tokens are stored only as SHA-256 hashes in DynamoDB, and API Gateway access logging is intentionally disabled so query credentials are not recorded.

Do not bind the daemon publicly or put the full terminal behind an unauthenticated reverse proxy.
