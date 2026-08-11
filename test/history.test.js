import { describe, expect, test } from "bun:test";
import { buildHistory } from "../src/history.js";

describe("buildHistory", () => {
  test("groups prompts by native Claude session and sorts by activity", () => {
    const rows = [
      { display: "/usage", timestamp: 100, project: "/missing/alpha", sessionId: "11111111-1111-4111-8111-111111111111" },
      { display: "Build the alpha feature", timestamp: 200, project: "/missing/alpha", sessionId: "11111111-1111-4111-8111-111111111111" },
      { display: "Fix beta", timestamp: 300, project: "/missing/beta", sessionId: "22222222-2222-4222-8222-222222222222" },
      { display: "Ship alpha", timestamp: 400, project: "/missing/alpha", sessionId: "11111111-1111-4111-8111-111111111111" },
    ].map(JSON.stringify);

    const history = buildHistory(rows);
    expect(history.map((item) => item.repoLabel)).toEqual(["alpha", "beta"]);
    expect(history[0].title).toBe("Build the alpha feature");
    expect(history[0].lastPrompt).toBe("Ship alpha");
    expect(history[0].promptCount).toBe(3);
    expect(history[0].available).toBe(false);
  });

  test("ignores malformed records", () => {
    expect(buildHistory(["not json", JSON.stringify({ sessionId: "bad" })])).toEqual([]);
  });
});
