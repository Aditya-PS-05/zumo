import { expect, test } from "bun:test";
import { messageBlocks } from "../public/message-markup.js";

test("agent markdown becomes safe structured content", () => {
  const blocks = messageBlocks("Found two issues.\n\n- **[P1] Broken `--flag`.** [Line 4](/tmp/app.js:4)\n- Read [docs](https://example.com)");
  expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list"]);
  expect(blocks[1].items[0]).toEqual([
    { type: "strong", children: [
      { type: "text", text: "[P1] Broken " },
      { type: "code", text: "--flag" },
      { type: "text", text: "." },
    ] },
    { type: "text", text: " " },
    { type: "reference", text: "Line 4", href: "/tmp/app.js:4" },
  ]);
  expect(blocks[1].items[1][1]).toEqual({ type: "link", text: "docs", href: "https://example.com" });
});
