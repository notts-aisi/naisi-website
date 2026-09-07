// A passing test that prints one line over the ceiling. Run by
// tests/output-lines.test.mjs under the guard, where it must FAIL. Not a
// `.test.mjs`, so `node --test tests/` never runs it on its own.
import { test } from "node:test";

test("passes, and prints a line the runner would stall on", () => {
  console.error("x".repeat(25_000));
});
