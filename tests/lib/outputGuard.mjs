/**
 * The output guard: no test process may print a line over `MAX_LINE_CHARS`.
 *
 * Loaded into every `npm test` process by the `--import` flag on the `test`
 * script in package.json, so it runs in the parent and in each child the
 * runner spawns per file. `tests/output-lines.test.mjs` pins that wiring and
 * proves the guard by spawning a file that prints such a line.
 *
 * ## Why a line length is worth a guard
 *
 * `tests/lib/tsLoader.mjs` (and the hand-copied loaders it replaced) turns
 * every module under test into a base64 `data:` URL, and a module's imports
 * are rewritten to the data: URLs of the modules they name. So a stack frame
 * inside code under test reads `at fn (data:text/javascript;base64,...)`, and
 * the URL carries the WHOLE module graph below that frame. When code under
 * test logs a caught error with its stack, which is what every best-effort
 * catch block in `src` does, one frame is one line and one line runs to
 * 440 KB.
 *
 * On a laptop that is noise. On GitHub's runner it is the job: the runner
 * handles output a line at a time and stalled for minutes on each such line,
 * 30 of a 33-minute job on 2026-09-06 against 10 seconds for the same command
 * locally. `.github/workflows/checks.yml` pipes `npm test` through `cut` as a
 * backstop, and keeps doing so; this guard stops the lines being produced in
 * the first place, so a new suite that exercises a failure path cannot put
 * the stall back without failing here.
 *
 * ## What it does
 *
 * Wraps the six `console` methods that write to the terminal. Each call is
 * formatted exactly as Node would print it (`util.format`, which is what
 * renders an Error's stack) and the longest line is measured; the real method
 * is then called with the original arguments, so nothing a test prints is
 * altered or withheld. A line over the ceiling is recorded, and at process
 * exit the file fails: the runner treats a non-zero exit from a test child as
 * a failure of that file even when every test in it passed, which is the
 * shape wanted here, because the fix is in the test, not in the code.
 *
 * ## What the fix looks like
 *
 * A test that drives a failure path and expects the code under test to log
 * the error mutes `console.error` for its own duration:
 *
 *     test("a sweep that fails keeps the row", async (t) => {
 *       t.mock.method(console, "error", () => {});
 *       ...
 *     });
 *
 * The mock is restored when the test ends, so the next test's logging is
 * printed as usual. Muting is the right fix rather than lowering the log
 * level in `src`: the message is correct in production, and a test that
 * asserts the failure path is the one place it is expected.
 *
 * ## Why console and not the streams
 *
 * The child's own reporter writes its serialised events to `process.stdout`,
 * and a frame is not a line. Everything `src` prints goes through `console`
 * (there is no `process.stdout.write` or `process.stderr.write` under `src`,
 * which the self-test pins), so `console` is the whole surface that matters.
 */
import { format } from "node:util";

export const MAX_LINE_CHARS = 20_000;

/** The methods that reach the terminal, and therefore the runner. */
const METHODS = ["log", "info", "debug", "warn", "error", "trace"];

/** The length of the longest line `console.<method>(...args)` would print. */
export function longestLineOf(...args) {
  let longest = 0;
  for (const line of format(...args).split("\n")) {
    if (line.length > longest) longest = line.length;
  }
  return longest;
}

const offences = [];

for (const method of METHODS) {
  const original = console[method];
  if (typeof original !== "function") continue;
  console[method] = function guarded(...args) {
    try {
      const longest = longestLineOf(...args);
      if (longest > MAX_LINE_CHARS) {
        offences.push({
          method,
          longest,
          head: format(...args).slice(0, 120).replace(/\s+/g, " "),
        });
      }
    } catch {
      // Measuring must never change what a test prints.
    }
    return original.apply(this, args);
  };
}

process.on("exit", () => {
  if (offences.length === 0) return;
  const lines = offences.map(
    (o) => `  console.${o.method}: a ${o.longest}-character line, starting "${o.head}"`,
  );
  process.stderr.write(
    `\n[output guard] ${process.argv[1] ?? "this process"} printed ${offences.length} ` +
      `line(s) over ${MAX_LINE_CHARS} characters. Such a line is almost always a ` +
      "stack trace whose frames are the test loader's data: URLs, and GitHub's " +
      "runner stalls for minutes on each one. If the test drives a failure path " +
      "the code under test is expected to log, mute it for that test with " +
      "`t.mock.method(console, \"error\", () => {})`. See tests/lib/outputGuard.mjs.\n" +
      lines.join("\n") +
      "\n",
  );
  process.exitCode = 1;
});
