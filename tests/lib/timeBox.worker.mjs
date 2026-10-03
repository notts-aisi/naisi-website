/**
 * The worker half of `timeBox.mjs`. It does one piece of work and reports how
 * long it took, or it is terminated by the test that started it.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createLoader } from "./tsLoader.mjs";

/** Build the input here, so two hundred thousand characters are not copied across threads. */
function inputOf({ input, repeat }) {
  if (typeof input === "string") return input;
  const [prefix, unit, total, suffix] = repeat;
  return prefix + unit.repeat(Math.ceil(total / unit.length)) + suffix;
}

const { work } = workerData;
const input = inputOf(work);
let run;
if (work.kind === "call") {
  const { loadTs } = createLoader();
  const loaded = await loadTs(work.module);
  run = () => loaded[work.fn](input);
} else if (work.kind === "regex-test") {
  const pattern = new RegExp(work.source, work.flags ?? "");
  run = () => pattern.test(input);
} else if (work.kind === "regex-replace") {
  const pattern = new RegExp(work.source, work.flags ?? "g");
  run = () => input.replace(pattern, " ");
} else {
  throw new Error(`timeBox: no such kind of work as ${JSON.stringify(work.kind)}`);
}

const started = performance.now();
const result = run();
parentPort.postMessage({ took: performance.now() - started, result: typeof result === "string" ? result : String(result) });
