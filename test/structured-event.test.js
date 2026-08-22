import { describe, expect, test } from "bun:test";
import { structuredEventView } from "../public/structured-event.js";

describe("structuredEventView", () => {
  test("keeps command output collapsed", () => {
    const view = structuredEventView({ type: "tool", title: "Command", text: "git status\nM app.js\n" });
    expect(view.text).toBe("git status");
    expect(view.detail).toContain("M app.js");
    expect(view.detailLabel).toBe("Command");
    expect(view.compact).toBe(true);
  });

  test("does not repeat the final answer in a completion row", () => {
    expect(structuredEventView({ type: "status", text: "the full answer" }).text).toBe("");
  });
});
