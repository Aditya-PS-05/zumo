import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "zumo-actions-"));
const previousHome = process.env.ZUMO_HOME;
process.env.ZUMO_HOME = home;
const actions = await import(`../src/actions.js?test=${Date.now()}`);
if (previousHome === undefined) delete process.env.ZUMO_HOME;
else process.env.ZUMO_HOME = previousHome;

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("action inbox", () => {
  test("deduplicates open actions and resolves a session", () => {
    const input = {
      sessionId: "p23-test-001", agent: "codex", repo: "/tmp/demo",
      kind: "approval", title: "Approval required", dedupeKey: "approval-1",
    };
    expect(actions.add(input).id).toBe(actions.add(input).id);
    expect(actions.all()).toHaveLength(1);
    actions.resolveSession(input.sessionId);
    expect(actions.all()).toHaveLength(0);
  });

  test("classifies obvious failures conservatively", () => {
    expect(actions.classifyEnd("Error: OAuth refresh failed")).toBe("failed");
    expect(actions.classifyEnd("Turn finished")).toBe("completed");
  });
});
