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

export function buildClaudeArgs({ extraArgs, sessionName, prompt = "", claudeSessionId, resumeSessionId = null }) {
  if (!sessionName) throw new Error("session name is required");
  const conversationArgs = resumeSessionId
    ? ["--resume", String(resumeSessionId)]
    : claudeSessionId
      ? ["--session-id", String(claudeSessionId)]
      : null;
  if (!conversationArgs) throw new Error("Claude session id is required");
  const args = [...parseArgString(extraArgs), ...conversationArgs, "--name", sessionName];
  if (prompt) args.push(String(prompt));
  return args;
}
