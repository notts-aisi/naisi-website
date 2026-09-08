/**
 * An encoded separator in any /api path is refused by the proxy before a
 * handler runs, on a REAL build of the app.
 *
 * `tests/api-addressable-ids.test.mjs` proves the code is in src/proxy.ts and
 * that the matcher names `/api/:path*`; only a request against a running
 * build proves the proxy actually sits in front of the API routes and answers
 * first. Both layers, the way every guard here is meant to work.
 *
 * The control request matters as much as the probe: the same route with a
 * plain id must get past the proxy and be turned away by the handler for
 * having no session, or a 404 on the probe could be a 404 on everything.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../lib/env.mjs";
import { anonFetch } from "../lib/session.mjs";

const ROUTE = (id) => `/api/tasks/${id}/notify`;

describe("encoded separators in API paths are refused at the proxy", () => {
  before(() => {
    loadEnv();
  });

  for (const id of ["abc%2Fcomments%2Fdef", "abc%2fdef"]) {
    it(`answers 404 from the proxy for ${id}`, async () => {
      const res = await anonFetch(ROUTE(id), { method: "POST" });
      assert.equal(res.status, 404, `expected the proxy's 404, got ${res.status}`);
      const body = await res.json().catch(() => null);
      assert.deepEqual(
        body,
        { error: "Not found" },
        "the 404 must be the proxy's JSON, not a page 404 or a handler's",
      );
    });
  }

  it("control: a plain id reaches the handler, which asks for a session", async () => {
    const res = await anonFetch(ROUTE("abc"), { method: "POST" });
    assert.equal(
      res.status,
      401,
      `a plain id should reach the handler and be refused for having no session, got ${res.status}`,
    );
  });
});
