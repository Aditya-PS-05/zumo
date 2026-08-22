import { describe, expect, test } from "bun:test";
import { buildHandoffPrompt, buildReviewPrompt } from "../src/handoff.js";

const source = { agent: "claude", repo: "/work/demo", lastLine: "Tests pass" };
const snapshot = { branch: "feature", status: " M app.js", diffStat: "1 file changed", diff: "+fixed" };

describe("portable handoff", () => {
  test("carries repository state without inventing a transcript format", () => {
    const prompt = buildHandoffPrompt(source, "codex", snapshot);
    expect(prompt).toContain("Source harness: claude");
    expect(prompt).toContain("Branch: feature");
    expect(prompt).toContain("+fixed");
  });

  test("makes independent review explicitly read-only", () => {
    expect(buildReviewPrompt(source, snapshot)).toContain("Do not modify files");
  });
});
