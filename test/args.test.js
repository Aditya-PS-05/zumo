import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, parseArgString } from "../src/args.js";

describe("parseArgString", () => {
  test("splits ordinary flags", () => {
    expect(parseArgString("--model sonnet --permission-mode acceptEdits")).toEqual([
      "--model", "sonnet", "--permission-mode", "acceptEdits",
    ]);
  });

  test("preserves quoted values without invoking a shell", () => {
    expect(parseArgString(`--append-system-prompt "keep the build green" --name='night shift'`)).toEqual([
      "--append-system-prompt", "keep the build green", "--name=night shift",
    ]);
  });

  test("supports empty and array input", () => {
    expect(parseArgString("")).toEqual([]);
    expect(parseArgString(["--model", "opus"])).toEqual(["--model", "opus"]);
  });

  test("rejects incomplete syntax", () => {
    expect(() => parseArgString("--model 'opus")).toThrow("unclosed quote");
    expect(() => parseArgString("--model opus\\")).toThrow("unfinished escape");
  });
});

describe("buildClaudeArgs", () => {
  test("pins a new native Claude session id", () => {
    expect(buildClaudeArgs({
      extraArgs: ["--model", "sonnet"],
      sessionName: "p23-demo-001",
      claudeSessionId: "11111111-1111-4111-8111-111111111111",
      prompt: "Build it",
    })).toEqual([
      "--model", "sonnet",
      "--remote-control",
      "--session-id", "11111111-1111-4111-8111-111111111111",
      "--name", "p23-demo-001",
      "Build it",
    ]);
  });

  test("resumes without injecting a new prompt", () => {
    expect(buildClaudeArgs({
      extraArgs: [],
      sessionName: "p23-demo-002",
      claudeSessionId: "ignored",
      resumeSessionId: "22222222-2222-4222-8222-222222222222",
    })).toEqual([
      "--remote-control",
      "--resume", "22222222-2222-4222-8222-222222222222",
      "--name", "p23-demo-002",
    ]);
  });

  test("can disable Remote Control for unsupported Claude authentication", () => {
    expect(buildClaudeArgs({
      extraArgs: [],
      sessionName: "p23-demo-003",
      claudeSessionId: "33333333-3333-4333-8333-333333333333",
      remoteControl: false,
    })).toEqual([
      "--session-id", "33333333-3333-4333-8333-333333333333",
      "--name", "p23-demo-003",
    ]);
  });
});
