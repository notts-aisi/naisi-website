// A passing test that prints a long line UNDER the ceiling. Run by
// tests/output-lines.test.mjs under the guard, where it must pass: the guard
// is about the lines that stall a runner, not about being tidy.
import { test } from "node:test";

test("passes, and prints a long line that is still a line", () => {
  console.error("y".repeat(19_000));
  console.log({ nested: { error: new Error("an ordinary stack is fine") } });
});
