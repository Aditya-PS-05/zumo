import { describe, expect, test } from "bun:test";
import { buildAgentArgs, validateAgentArgs } from "../src/args.js";

const base = {
  sessionName: "p23-agent-demo-001",
  prompt: "Build it",
  nativeSessionId: "11111111-1111-4111-8111-111111111111",
};

describe("buildAgentArgs", () => {
  test("builds each supported interactive CLI", () => {
    expect(buildAgentArgs({ ...base, agent: "codex", extraArgs: ["--model", "gpt-5"] }))
      .toEqual(["--model", "gpt-5", "--no-alt-screen", "Build it"]);
    expect(buildAgentArgs({ ...base, agent: "opencode", extraArgs: ["--model", "openai/gpt-5"] }))
      .toEqual(["--model", "openai/gpt-5", "--prompt", "Build it"]);
    expect(buildAgentArgs({ ...base, agent: "pi", extraArgs: [] }))
      .toEqual(["--session-id", base.nativeSessionId, "--name", base.sessionName, "Build it"]);
  });

  test("rejects options that would replace Zumo-managed session state", () => {
    expect(() => validateAgentArgs("claude", "--resume abc")).toThrow("managed by Zumo");
    expect(() => validateAgentArgs("opencode", "--session abc")).toThrow("managed by Zumo");
    expect(() => validateAgentArgs("pi", "--session-id abc")).toThrow("managed by Zumo");
    expect(() => validateAgentArgs("codex", "resume abc")).toThrow("must be flags");
    expect(() => validateAgentArgs("toString", "")).toThrow("unsupported agent");
  });
});
