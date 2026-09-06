/**
 * Guards on the reCAPTCHA harness bypass (src/lib/recaptcha/bypass.ts), run
 * under `npm test` with no credentials.
 *
 * The bypass lets the end-to-end harness through the reCAPTCHA gate on the
 * DEV backend, and it is safe only while four things stay true:
 *
 *   1. Its secret is never provisioned through `apphosting.yaml`, which the
 *      production backend reads. The variable lives in the dev backend's
 *      console environment and nowhere in this repository.
 *   2. Without the variable the path does not exist: the decision function
 *      returns false before looking at the header or the identity.
 *   3. It is consulted only for a request that carries NO token, so a human
 *      on dev (whose widget always sends one) is verified for real, and only
 *      the harness namespace `e2e-<alnum>@e2e.invalid` can clear it.
 *   4. It sits in the gates, never inside `verifyRecaptcha`, so a present
 *      token is always checked with Google whatever headers came with it.
 *
 * 1, 3 and 4 are source checks; 2 and the identity rule are tested
 * behaviourally by transpiling the module and calling it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");
const BYPASS_TS = join(SRC, "lib", "recaptcha", "bypass.ts");
const VERIFIER_TS = join(SRC, "lib", "recaptcha", "server.ts");
const ENV_NAME = "E2E_RECAPTCHA_BYPASS_SECRET";
const HEADER = "x-e2e-recaptcha-bypass";

/** The gates that may consult the bypass, and the tokenless guard each must carry. */
const GATES = [
  {
    file: "src/lib/admissions/applyContext.ts",
    guard: /token === undefined && bypass && recaptchaBypassGranted\(bypass\.headers, bypass\.email\)/,
  },
  {
    file: "src/app/api/register/route.ts",
    guard: /recaptchaToken === undefined && recaptchaBypassGranted\(req\.headers, email\)/,
  },
];

function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

test("the bypass secret is never provisioned through apphosting yaml", () => {
  const yamls = readdirSync(REPO_ROOT).filter((f) => /^apphosting.*\.ya?ml$/.test(f));
  assert.ok(yamls.includes("apphosting.yaml"), "apphosting.yaml is missing; the check has nothing to read");
  for (const file of yamls) {
    assert.ok(
      !read(file).includes(ENV_NAME),
      `${file} mentions ${ENV_NAME}. That file is read by the production backend; the ` +
        "bypass secret lives only in the dev backend's console environment variables.",
    );
  }
});

test("the bypass is server-only, and the verifier itself never consults it", () => {
  const source = readFileSync(BYPASS_TS, "utf8");
  assert.match(source, /^import "server-only";/m, "bypass.ts must start with import \"server-only\"");
  assert.match(source, new RegExp(`RECAPTCHA_BYPASS_ENV = "${ENV_NAME}"`));
  assert.match(source, new RegExp(`RECAPTCHA_BYPASS_HEADER = "${HEADER}"`));
  const verifier = readFileSync(VERIFIER_TS, "utf8");
  assert.ok(
    !/recaptchaBypassGranted|recaptcha\/bypass|RECAPTCHA_BYPASS/.test(verifier),
    "src/lib/recaptcha/server.ts reaches the bypass. verifyRecaptcha must stay a pure " +
      "verifier so a present token is always checked with Google; the gates decide.",
  );
});

test("only the two gates import the bypass, and each consults it only for a tokenless request", () => {
  const importers = walk(SRC)
    .filter((f) => readFileSync(f, "utf8").includes("recaptcha/bypass"))
    .map((f) => relative(REPO_ROOT, f))
    .sort();
  assert.deepEqual(
    importers,
    GATES.map((g) => g.file).sort(),
    "the set of files importing src/lib/recaptcha/bypass changed. Every importer is a gate " +
      "that must carry the tokenless guard below; add it to GATES with its guard, or remove the import.",
  );
  for (const gate of GATES) {
    assert.ok(existsSync(join(REPO_ROOT, gate.file)), `${gate.file} is gone or moved`);
    assert.match(
      read(gate.file),
      gate.guard,
      `${gate.file} consults recaptchaBypassGranted without the tokenless guard. The bypass ` +
        "applies only when no token was sent; a token that is present is verified for real.",
    );
  }
});

test("every caller of requireRecaptcha hands it the request headers and the acting identity", () => {
  const callers = walk(join(SRC, "app", "api")).filter((f) =>
    readFileSync(f, "utf8").includes("requireRecaptcha("),
  );
  assert.ok(callers.length >= 3, `expected the three admissions apply routes, found ${callers.length}`);
  for (const file of callers) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/requireRecaptcha\(([\s\S]*?)\);/g)) {
      assert.match(
        match[1],
        /headers:\s*req\.headers/,
        `${relative(REPO_ROOT, file)} calls requireRecaptcha without the request headers, so ` +
          "the harness bypass cannot apply there and the nightly dev run skips that leg.",
      );
      assert.match(
        match[1],
        /email:\s*user\.email/,
        `${relative(REPO_ROOT, file)} calls requireRecaptcha without the signed-in account's ` +
          "email, which is the identity the bypass checks against the harness namespace.",
      );
    }
  }
});

/** Transpiles the leaf module and imports it, with server-only stubbed out. */
async function loadBypass() {
  const tsc = (await import("typescript")).default;
  const source = readFileSync(BYPASS_TS, "utf8").replace(/^import "server-only";\s*$/m, "");
  const { outputText } = tsc.transpileModule(source, {
    fileName: BYPASS_TS,
    compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText, "utf8").toString("base64")}`);
}

test("recaptchaBypassGranted refuses everything unless all three conditions hold", async () => {
  const { recaptchaBypassGranted, isHarnessIdentity } = await loadBypass();
  const saved = process.env[ENV_NAME];
  const quiet = console.log;
  console.log = () => {};
  try {
    const harness = "e2e-abc123@e2e.invalid";
    const withHeader = (value) => new Headers(value === null ? {} : { [HEADER]: value });

    delete process.env[ENV_NAME];
    assert.equal(
      recaptchaBypassGranted(withHeader("anything"), harness),
      false,
      "with the variable unset the path must not exist, whatever the header and identity",
    );

    process.env[ENV_NAME] = "s3cret-value-for-the-test";
    assert.equal(recaptchaBypassGranted(withHeader(null), harness), false, "no header");
    assert.equal(recaptchaBypassGranted(withHeader("wrong"), harness), false, "wrong header");
    assert.equal(
      recaptchaBypassGranted(withHeader("s3cret-value-for-the-tes"), harness),
      false,
      "a header one byte short",
    );
    assert.equal(
      recaptchaBypassGranted(withHeader("s3cret-value-for-the-test"), "zach@example.com"),
      false,
      "a real-looking address",
    );
    assert.equal(
      recaptchaBypassGranted(withHeader("s3cret-value-for-the-test"), "e2e-admin@naisi-e2e.invalid"),
      false,
      "an .invalid address outside the harness namespace (the owner-made admin account)",
    );
    assert.equal(recaptchaBypassGranted(withHeader("s3cret-value-for-the-test"), null), false, "no identity");
    assert.equal(recaptchaBypassGranted(withHeader("s3cret-value-for-the-test"), ""), false, "empty identity");
    assert.equal(
      recaptchaBypassGranted(withHeader("s3cret-value-for-the-test"), harness),
      true,
      "the right header and a harness identity is the one case that passes",
    );
    assert.equal(
      recaptchaBypassGranted(withHeader("s3cret-value-for-the-test"), "E2E-ABC123@E2E.INVALID"),
      true,
      "case is normalised the way the harness normalises addresses",
    );

    assert.equal(isHarnessIdentity("e2e-lab@gmail.com"), false, "a plausible real address with the prefix");
    assert.equal(isHarnessIdentity("e2e-a1@e2e.invalid"), true);
  } finally {
    console.log = quiet;
    if (saved === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = saved;
  }
});
