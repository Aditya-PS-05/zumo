export function parseArgString(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    if (!input.every((value) => typeof value === "string" && !value.includes("\0"))) {
      throw new Error("extraArgs array must contain strings");
    }
    return [...input];
  }
  if (typeof input !== "string") throw new Error("extraArgs must be a string or array");

  const args = [];
  let current = "";
  let quote = null;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }

  if (escaped) throw new Error("extraArgs ends with an unfinished escape");
  if (quote) throw new Error("extraArgs has an unclosed quote");
  if (started) args.push(current);
  return args;
}

export const AGENTS = Object.freeze({
  claude: { label: "Claude Code", defaultBin: "claude" },
  codex: { label: "Codex", defaultBin: "codex" },
  opencode: { label: "OpenCode", defaultBin: "opencode" },
  pi: { label: "Pi", defaultBin: "pi" },
});

const MANAGED_FLAGS = {
  claude: ["--resume", "-r", "--continue", "-c", "--session-id", "--name"],
  codex: [],
  opencode: ["--prompt", "-p", "--session", "-s", "--continue", "-c"],
  pi: ["--session-id", "--session", "--name", "--continue", "-c"],
};

export function validateAgentArgs(agent, extraArgs) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`unsupported agent: ${agent}`);
  const args = parseArgString(extraArgs);
  const blocked = MANAGED_FLAGS[agent];
  const managed = args.find((arg) => blocked.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
  if (managed) throw new Error(`${managed} is managed by Zumo`);
  if (agent === "codex" && args[0] && !args[0].startsWith("-")) {
    throw new Error("Codex launch options must be flags, not a subcommand");
  }
  return args;
}

export function buildAgentArgs({
  agent = "claude", extraArgs, sessionName, prompt = "", nativeSessionId = null, resumeSessionId = null,
}) {
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`unsupported agent: ${agent}`);
  if (!sessionName) throw new Error("session name is required");
  const args = parseArgString(extraArgs);

  if (agent === "claude") {
    const conversationArgs = resumeSessionId
      ? ["--resume", String(resumeSessionId)]
      : nativeSessionId
        ? ["--session-id", String(nativeSessionId)]
        : null;
    if (!conversationArgs) throw new Error("Claude session id is required");
    args.push(...conversationArgs, "--name", sessionName);
  } else if (agent === "codex") {
    if (!args.includes("--no-alt-screen")) args.push("--no-alt-screen");
  } else if (agent === "opencode") {
    args.push("--prompt", String(prompt));
    return args;
  } else if (agent === "pi") {
    if (!nativeSessionId) throw new Error("Pi session id is required");
    args.push("--session-id", String(nativeSessionId), "--name", sessionName);
  }

  if (prompt) args.push(String(prompt));
  return args;
}

export function buildClaudeArgs({ extraArgs, sessionName, prompt = "", claudeSessionId, resumeSessionId = null }) {
  return buildAgentArgs({
    agent: "claude", extraArgs, sessionName, prompt,
    nativeSessionId: claudeSessionId, resumeSessionId,
  });
}
