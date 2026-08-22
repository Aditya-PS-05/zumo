import { expect, test } from "bun:test";
import { generatePairingCode } from "../src/relay.js";

test("pairing codes carry 80 bits in typo-resistant base32", () => {
  const codes = new Set(Array.from({ length: 100 }, generatePairingCode));
  expect(codes.size).toBe(100);
  for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{16}$/);
});
