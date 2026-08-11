import { execFile } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { CONFIG, PENDING_DIR, RECORDINGS_DIR, REPO_ROOT } from "./config.js";

export const SESSION_ID_RE = /^p23-[a-z0-9][a-z0-9-]*$/;
const VIEW_PREFIX = "p23v-";

export function tmux(args) {
  return new Promise((resolvePromise, reject) => {
    execFile("tmux", args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolvePromise(stdout);
    });
  });
}

// Base (managed) sessions only — view sessions are grouped attach clients, not sessions of record.
export async function listSessions() {
  let out;
  try {
    out = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_created}"]);
  } catch {
    return []; // no tmux server running ⇒ no sessions
  }
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, created] = line.split("\t");
      return { id: name, createdAt: Number(created) * 1000 };
    })
    .filter((s) => SESSION_ID_RE.test(s.id) && !s.id.startsWith(VIEW_PREFIX));
}

export async function hasSession(id) {
  try {
    await tmux(["has-session", "-t", `=${id}`]);
    return true;
  } catch {
    return false;
  }
}

// Launch contract: no user data ever touches a shell parser. The prompt goes into a
// pending file; tmux runs a fixed argv referencing only the id.
export async function newSession(id, repo, prompt, extraArgs, { claudeSessionId, resumeSessionId = null } = {}) {
  const pending = join(PENDING_DIR, `${id}.json`);
  writeFileSync(pending, JSON.stringify({
    prompt,
    extraArgs: extraArgs || "",
    repo,
    claudeBin: CONFIG.claudeBin,
    port: CONFIG.port,
    claudeSessionId,
    resumeSessionId,
  }), { flag: "wx", mode: 0o600 });
  const launcher = join(REPO_ROOT, "bin", "launch.js");
  try {
    // tmux joins its command argv through a shell. All values after the fixed
    // launcher are generated session IDs; prompt and flags stay in `pending`.
    await tmux(["new-session", "-d", "-s", id, "-c", repo, process.execPath, launcher, id, pending]);
    await tmux(["set-window-option", "-t", `=${id}:`, "window-size", "latest"]);
    const recFilter = join(REPO_ROOT, "bin", "rec-filter.js");
    const recFile = join(RECORDINGS_DIR, `${id}.jsonl`);
    // pipe-pane's command is run by tmux via sh — fixed absolute paths only, no user data.
    await tmux(["pipe-pane", "-t", `=${id}:`, "-o", `${shellQuote(process.execPath)} ${shellQuote(recFilter)} ${shellQuote(recFile)}`]);
  } catch (e) {
    rmSync(pending, { force: true });
    try { await tmux(["kill-session", "-t", `=${id}`]); } catch {}
    throw e;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

// Kill a managed session and every grouped phone-view attached to it.
// Order is load-bearing: the base dies FIRST so attachPty's hasSession() guard refuses
// any in-flight phone reconnect. Otherwise a reconnect spawned between our list and our
// kill leaves a grouped view alive, and a grouped view keeps the shared tmux window (and
// Claude) running after the "kill" — the session then reappears and the phone reconnects
// straight back onto the old agent. After the base is gone we loop-kill the whole session
// group until it is empty, sweeping up any view that raced in a hair earlier.
export async function killSession(id) {
  try { await tmux(["kill-session", "-t", `=${id}`]); } catch { /* already gone / no server */ }
  const viewPrefix = `${VIEW_PREFIX}${id.slice(4)}-`;
  for (let attempt = 0; attempt < 6; attempt++) {
    let lines;
    try {
      lines = (await tmux(["list-sessions", "-F", "#{session_name}\t#{session_group}"])).trim().split("\n").filter(Boolean);
    } catch {
      return; // no server ⇒ nothing left to kill
    }
    const targets = lines
      .map((line) => line.split("\t"))
      .filter(([name, group]) => name === id || (group || "").replace(/^=/, "") === id || name.startsWith(viewPrefix))
      .map(([name]) => name);
    if (!targets.length) return;
    for (const name of targets) {
      try { await tmux(["kill-session", "-t", `=${name}`]); } catch {}
    }
    await new Promise((r) => setTimeout(r, 60)); // let a mid-flight attach surface, then resweep
  }
}

// Grouped view session for a phone attach: shares windows with the base session but
// keeps its own client size (window-size latest); destroys itself when unattached so
// reconnect churn never leaks sessions into `tmux ls`.
export function viewSessionName(id) {
  return `${VIEW_PREFIX}${id.slice(4)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function destroyView(view) {
  try { await tmux(["kill-session", "-t", `=${view}`]); } catch {}
}
