#!/usr/bin/env node
import { readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { CONFIG, PENDING_DIR } from "../src/config.js";
import { SESSION_ID_RE } from "../src/tmux.js";
import { AGENTS, buildAgentArgs } from "../src/args.js";

const id = process.argv[2] || "";
if (!SESSION_ID_RE.test(id)) {
  console.error("zumo: invalid session id");
  process.exit(2);
}

const pending = process.argv[3] || join(PENDING_DIR, `${id}.json`);
let launch;
try {
  launch = JSON.parse(readFileSync(pending, "utf8"));
  rmSync(pending, { force: true });
} catch (error) {
  console.error(`zumo: could not read launch request: ${error.message}`);
  process.exit(2);
}

const prompt = String(launch.prompt || "");
if (!prompt && !launch.resumeSessionId) {
  console.error("zumo: launch request has no prompt");
  process.exit(2);
}

const agent = String(launch.agent || "claude");
if (!Object.hasOwn(AGENTS, agent)) {
  console.error(`zumo: unsupported agent: ${agent}`);
  process.exit(2);
}
const agentBin = String(launch.agentBin || launch.claudeBin || CONFIG.agentBins[agent]);
const port = Number(launch.port) || CONFIG.port;
let args;
try {
  args = buildAgentArgs({
    agent,
    extraArgs: launch.extraArgs,
    sessionName: id,
    prompt,
    nativeSessionId: launch.nativeSessionId || launch.claudeSessionId,
    resumeSessionId: launch.resumeSessionId,
    remoteControl: launch.remoteControl !== false,
  });
} catch (error) {
  console.error(`zumo: ${error.message}`);
  process.exit(2);
}
const child = spawn(agentBin, args, {
  cwd: launch.repo,
  env: {
    ...process.env,
    PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
    ZUMO_SESSION: id,
    ZUMO_AGENT: agent,
    ZUMO_PORT: String(port),
    // Legacy aliases: keep an already-installed ~/.port23 hook working across the rename
    // without forcing a re-run of setup.
    PORT23_SESSION: id,
    PORT23_PORT: String(port),
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`zumo: failed to launch ${agentBin}: ${error.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
