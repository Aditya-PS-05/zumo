import { describe, expect, test } from "bun:test";
import { composedInput } from "../public/composer.js";

describe("composedInput", () => {
  test("submits a single line once", () => {
    expect(composedInput("fix the flicker")).toBe("fix the flicker\r");
  });

  test("uses bracketed paste for multiline prompts", () => {
    expect(composedInput("first\r\nsecond")).toBe("\x1b[200~first\nsecond\x1b[201~\r");
  });

  test("ignores blank messages", () => {
    expect(composedInput("  \n")).toBe("");
  });
});
