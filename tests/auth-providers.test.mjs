/**
 * The sign-in providers the code calls are the ones the guard holds each
 * project to.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * `scripts/check-auth-providers.mjs` compares each Firebase project with a
 * registry of the providers the code needs. That comparison is only as good as
 * the registry, so this is the other seam: the registry against the code.
 *
 *  - A sign-in call nobody classified fails. Otherwise a new provider could be
 *    wired into the app, switched on for dev while it was being built, and
 *    never switched on for production: the October 2026 defect exactly.
 *  - A provider no call needs any more fails too. The live check would go on
 *    insisting it stays ON, and an unused sign-in provider is a way into the
 *    project that nothing reviews.
 *
 * The second half holds how the script READS a project's answer, because a
 * misread there is a guard that passes on the failure it exists for.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";
import {
  REQUIRED_PROVIDERS,
  NO_PROVIDER_NEEDED,
  PROVIDERS_KEPT_OFF,
  PROJECTS,
  readRefusal,
  probeProvider,
  checkProjectPublicly,
  checkAdminConfig,
} from "../scripts/check-auth-providers.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const posix = (file) => relative(REPO_ROOT, file).split("\\").join("/");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** Every VALUE imported from `firebase/auth` under src, with the files that import it. */
function authImports() {
  const found = new Map();
  for (const file of walk(join(REPO_ROOT, "src"))) {
    const code = stripSource(readFileSync(file, "utf8"), { keepStrings: true });
    if (!/["']firebase\/auth["']/.test(code)) continue;
    const named = [...code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']firebase\/auth["']/g)];
    // Any other way of reaching the module (a namespace import, a dynamic
    // import, a re-export) is one this reader cannot classify. Refuse it
    // rather than skip it.
    const mentions = [...code.matchAll(/["']firebase\/auth["']/g)].length;
    assert.equal(
      named.length,
      mentions,
      `${posix(file)} reaches firebase/auth in a way this guard cannot read (a namespace or dynamic import). ` +
        `Use named imports, so each sign-in call can be matched to the provider it needs.`,
    );
    for (const [, typeOnly, names] of named) {
      if (typeOnly) continue;
      for (const raw of names.split(",").map((n) => n.trim()).filter(Boolean)) {
        if (raw.startsWith("type ")) continue;
        const name = raw.replace(/\s+as\s+.*$/, "");
        if (!found.has(name)) found.set(name, []);
        found.get(name).push(posix(file));
      }
    }
  }
  return found;
}

describe("the registry against the code", () => {
  const imports = authImports();
  const classified = new Map();
  for (const [provider, { calls }] of Object.entries(REQUIRED_PROVIDERS)) {
    for (const call of calls) classified.set(call, provider);
  }

  test("the walk finds the sign-in calls", () => {
    assert.ok(imports.size >= 5, "almost nothing imports firebase/auth: the walk is reading the wrong tree");
    assert.ok(imports.has("signInWithEmailAndPassword"));
  });

  test("every firebase/auth import is classified: it needs a provider, or it is listed as needing none", () => {
    const unclassified = [...imports.keys()].filter((name) => !classified.has(name) && !(name in NO_PROVIDER_NEEDED));
    assert.deepEqual(
      unclassified,
      [],
      "A new firebase/auth call. Add it to REQUIRED_PROVIDERS in scripts/check-auth-providers.mjs under the " +
        "provider that must be switched on for it to work, or to NO_PROVIDER_NEEDED with the reason. Then " +
        "make sure that provider is on for EVERY project, production included: the script checks.",
    );
  });

  test("no call is classified both ways", () => {
    assert.deepEqual([...classified.keys()].filter((name) => name in NO_PROVIDER_NEEDED), []);
  });

  test("every provider the guard requires is still called by something", () => {
    for (const [provider, { calls }] of Object.entries(REQUIRED_PROVIDERS)) {
      const used = calls.filter((call) => imports.has(call));
      assert.ok(
        used.length > 0,
        `Nothing under src calls ${calls.join(" or ")} any more, so nothing needs the ${provider} provider. ` +
          `Remove it from REQUIRED_PROVIDERS and switch it off on every project.`,
      );
    }
  });

  test("every entry in both lists is a call that exists in the tree", () => {
    const listed = [...classified.keys(), ...Object.keys(NO_PROVIDER_NEEDED)];
    assert.deepEqual(listed.filter((name) => !imports.has(name)), [], "a stale entry: nothing imports it any more");
  });

  test("every entry carries its reason", () => {
    for (const [provider, entry] of Object.entries(REQUIRED_PROVIDERS)) {
      assert.ok(entry.why.length > 40, `${provider} has no reason worth reading`);
      assert.match(entry.why, /src\//, `${provider}'s reason does not name the code that needs it`);
    }
    for (const [name, why] of Object.entries(NO_PROVIDER_NEEDED)) assert.ok(why.length > 10, name);
  });

  test("a provider is required or kept off, never both", () => {
    assert.deepEqual(Object.keys(PROVIDERS_KEPT_OFF).filter((p) => p in REQUIRED_PROVIDERS), []);
  });

  test("both projects are held to it", () => {
    assert.deepEqual(Object.keys(PROJECTS).sort(), ["naisi-uk-dev", "naisi-website"]);
  });
});

describe("how a project's answer is read", () => {
  test("a refused credential means the provider is on; a refused operation means it is off", () => {
    assert.equal(readRefusal("INVALID_LOGIN_CREDENTIALS"), "on");
    assert.equal(readRefusal("EMAIL_NOT_FOUND"), "on");
    assert.equal(readRefusal("INVALID_IDP_RESPONSE : Unable to parse Google id_token: not-a-token"), "on");
    assert.equal(readRefusal("PASSWORD_LOGIN_DISABLED"), "off");
    assert.equal(readRefusal("OPERATION_NOT_ALLOWED : The identity provider configuration is not found."), "off");
  });

  test("anything else is unknown, never guessed", () => {
    for (const message of [
      "TOO_MANY_ATTEMPTS_TRY_LATER",
      "INVALID_CREDENTIAL_OR_PROVIDER_ID : Invalid IdP response/credential",
      "API key not valid. Please pass a valid API key.",
      "",
      undefined,
    ]) {
      assert.equal(readRefusal(message), "unknown", String(message));
    }
  });

  /** A project that answers as configured. */
  function project({ password = true, google = true, on = [], broken = null, accept = false } = {}) {
    return async (url, init) => {
      if (url.endsWith("/__/firebase/init.json")) {
        if (broken === "config") return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ projectId: "naisi-website", apiKey: "public-key" }) };
      }
      assert.ok(url.includes("key=public-key"), "the probe did not use the key the project published");
      const refuse = (message) => ({ ok: false, status: 400, json: async () => ({ error: { message } }) });
      if (accept) return { ok: true, status: 200, json: async () => ({ idToken: "x" }) };
      if (broken === "quota") return refuse("TOO_MANY_ATTEMPTS_TRY_LATER");
      if (url.includes("accounts:signInWithPassword")) {
        return refuse(password ? "INVALID_LOGIN_CREDENTIALS" : "PASSWORD_LOGIN_DISABLED");
      }
      const provider = decodeURIComponent(JSON.parse(init.body).postBody.match(/providerId=([^&]+)/)[1]);
      const enabled = provider === "google.com" ? google : on.includes(provider);
      return refuse(enabled ? "INVALID_IDP_RESPONSE : could not parse" : "OPERATION_NOT_ALLOWED : not found");
    };
  }

  test("a project with exactly the required providers passes", async () => {
    const result = await checkProjectPublicly("naisi-website", project());
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.unknowns, []);
    assert.equal(result.lines.length, Object.keys(REQUIRED_PROVIDERS).length + Object.keys(PROVIDERS_KEPT_OFF).length);
  });

  test("Email/Password switched off is a failure that says what breaks", async () => {
    const result = await checkProjectPublicly("naisi-website", project({ password: false }));
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /Email\/Password sign-in is OFF/);
    assert.match(result.failures[0], /strands/);
  });

  test("Google switched off is a failure", async () => {
    const result = await checkProjectPublicly("naisi-website", project({ google: false }));
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /Google sign-in is OFF/);
  });

  test("a provider nothing uses, switched on, is a failure", async () => {
    const result = await checkProjectPublicly("naisi-website", project({ on: ["github.com"] }));
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /github\.com sign-in is ON/);
  });

  test("an answer it cannot read is reported as a look that failed, not as a pass", async () => {
    const result = await checkProjectPublicly("naisi-website", project({ broken: "quota" }));
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.lines, []);
    assert.equal(result.unknowns.length, Object.keys(REQUIRED_PROVIDERS).length + Object.keys(PROVIDERS_KEPT_OFF).length);
  });

  test("a made-up credential being ACCEPTED is not read as anything", async () => {
    const { state } = await probeProvider("password", "public-key", project({ accept: true }));
    assert.equal(state, "unknown");
  });

  test("a project whose web configuration cannot be read throws, so the caller cannot pass", async () => {
    await assert.rejects(() => checkProjectPublicly("naisi-website", project({ broken: "config" })), /could not read/);
  });

  test("a configuration that describes another project is refused", async () => {
    await assert.rejects(() => checkProjectPublicly("naisi-uk-dev", project()), /describes project/);
  });

  test("a provider with no recorded credential shape cannot be probed by accident", async () => {
    await assert.rejects(() => probeProvider("microsoft.com", "public-key", project()), /no credential shape/);
  });
});

describe("the configuration read (--admin) checks both directions", () => {
  const good = {
    signIn: { email: { enabled: true, passwordRequired: true }, anonymous: { enabled: false } },
    emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
  };
  const google = { name: "projects/p/defaultSupportedIdpConfigs/google.com", enabled: true };
  const failuresOf = (config, idps) => checkAdminConfig("p", config, idps).failures;

  test("the configuration both projects have today passes", () => {
    assert.deepEqual(failuresOf(good, [google]), []);
  });

  test("each thing that can be wrong is a failure of its own", () => {
    const cases = {
      "Email/Password sign-in is OFF": [{ ...good, signIn: { ...good.signIn, email: { enabled: false } } }, [google]],
      "email link": [{ ...good, signIn: { ...good.signIn, email: { enabled: true, passwordRequired: false } } }, [google]],
      "anonymous sign-in is ON": [{ ...good, signIn: { ...good.signIn, anonymous: { enabled: true } } }, [google]],
      "phone sign-in is ON": [{ ...good, signIn: { ...good.signIn, phoneNumber: { enabled: true } } }, [google]],
      "google.com sign-in is OFF": [good, [{ ...google, enabled: false }]],
      "microsoft.com sign-in is ON": [good, [google, { name: "projects/p/defaultSupportedIdpConfigs/microsoft.com", enabled: true }]],
      "enumeration protection is OFF": [{ ...good, emailPrivacyConfig: {} }, [google]],
    };
    for (const [expected, [config, idps]] of Object.entries(cases)) {
      const failures = failuresOf(config, idps);
      assert.equal(failures.length, 1, `${expected}: ${JSON.stringify(failures)}`);
      assert.ok(failures[0].includes(expected), `${expected} was reported as: ${failures[0]}`);
    }
  });

  test("an empty configuration fails rather than passing on absence", () => {
    assert.ok(failuresOf({}, []).length >= 2);
    assert.ok(failuresOf(undefined, undefined).length >= 2);
  });
});

describe("it runs where it can see production", () => {
  test("the daily workflow runs the public look, with no credential", () => {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/config-drift.yml"), "utf8");
    assert.match(workflow, /\n {6}- run: node scripts\/check-auth-providers\.mjs\n/);
    assert.doesNotMatch(workflow, /id-token|google-github-actions\/auth|secrets\./, "the drift workflow must need nothing it could lose");
    assert.match(workflow, /\n {2}schedule:\n/);
  });
});
