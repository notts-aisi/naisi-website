/**
 * Run a piece of work that might never finish, and stop it if it does not.
 *
 * WHY THIS EXISTS. A test for "this pattern is not slow" that simply times the
 * call cannot fail the way it needs to. A regular expression that backtracks
 * blocks the thread it runs on, so no timer fires, no assertion is reached,
 * and the regression the test exists to catch shows up as a suite that hangs
 * until the job is killed hours later, with nothing pointing at the cause.
 *
 * So the work runs in a worker thread, the test waits for it with a limit, and
 * a worker that overruns is terminated and reported BY NAME. A slow pattern
 * then costs the suite the limit, once, and says which input did it.
 *
 * `work` is one of:
 *   { kind: "call", module, fn, input }            call an export of a module under src
 *   { kind: "regex-test", source, flags, input }    pattern.test(input)
 *   { kind: "regex-replace", source, flags, input } input.replace(pattern, " ")
 * and `input` may be given as `repeat: [prefix, unit, totalLength, suffix]`
 * instead, which the worker builds itself.
 */
import { Worker } from "node:worker_threads";

/**
 * @returns {Promise<{ finished: true, took: number, result: string } | { finished: false, limitMs: number }>}
 */
export function timeBoxed(work, limitMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./timeBox.worker.mjs", import.meta.url), { workerData: { work } });
    const timer = setTimeout(() => {
      worker.terminate().then(() => resolve({ finished: false, limitMs }));
    }, limitMs);
    worker.once("message", (message) => {
      clearTimeout(timer);
      worker.terminate().then(() => resolve({ finished: true, ...message }));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
