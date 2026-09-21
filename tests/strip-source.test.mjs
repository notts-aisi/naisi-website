/**
 * The source reader the guards read through: `tests/lib/stripSource.mjs`.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * A guard is only as good as its reading of the file. When this reader loses
 * its place it does not throw: it returns less text, and a scanner handed
 * less text reports "nothing to see". That is the failure these tests exist
 * for, and it happened. In `keepStrings` mode the reader did not track strings
 * at all, so the `//` in `"https://example.com"` read as the start of a
 * comment and the rest of the line was dropped, code included. Seven guards
 * read through that mode. Nothing in `src` happened to be hidden by it, which
 * is luck and not a property.
 *
 * So this file pins the reader directly, both modes, and then walks the tree:
 * every file the `keepStrings` guards read must come back with every line of
 * code that the ordinary mode sees.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSource } from "./lib/stripSource.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = (src) => stripSource(src, { keepStrings: true });

describe("keepStrings: comments go, strings stay, and code after a string survives", () => {
  test("a // inside a string is not a comment", () => {
    const src = 'const url = "https://example.com/a"; await rateLimit(key);';
    assert.equal(keep(src), src);
  });

  test("a /* inside a string is not a comment", () => {
    const src = "const glob = 'src/**/*.ts'; keepGoing();";
    assert.equal(keep(src), src);
  });

  test("a // inside a template is not a comment, and the template is kept whole", () => {
    const src = "const url = `https://${host}/q/${slug}`; after();";
    assert.equal(keep(src), src);
  });

  test("the literal a guard searches for is still there, with its template", () => {
    const src = "const limit = rateLimit(`q:scan:ip:${ip}`, MAX, WINDOW); // per address\nnext();";
    const out = keep(src);
    assert.ok(out.includes("rateLimit(`q:scan:ip:${ip}`"));
    assert.ok(out.includes("next();"));
    assert.ok(!out.includes("per address"));
  });

  test("a real comment after a string is still removed", () => {
    assert.equal(keep('const a = "x"; // gone\nb();'), 'const a = "x";  \nb();');
    assert.equal(keep('const a = "x"; /* gone */ b();'), 'const a = "x";   b();');
  });

  test("an escaped quote does not end the string early", () => {
    const src = 'const s = "she said \\"hi\\" // not a comment"; after();';
    assert.equal(keep(src), src);
  });

  test("an apostrophe in a trailing comment does not open a string", () => {
    // The desync the tokeniser was written to end, in this mode too.
    const out = keep("first(); // don't\nsecond(); // won't\nthird();");
    assert.ok(out.includes("second();") && out.includes("third();"));
  });

  test("a mention of a literal in a comment is not the literal", () => {
    const out = keep('// call rateLimit("x") here one day\nnothing();');
    assert.ok(!out.includes("rateLimit"));
  });

  test("an unterminated string gives up at the line break, not at the end of the file", () => {
    const out = keep('const broken = "oops\nstillHere();');
    assert.ok(out.includes("stillHere();"));
  });
});

describe("the ordinary mode is unchanged: bodies emptied, shape kept", () => {
  test("a string keeps its quotes and loses its body", () => {
    assert.equal(stripSource('doc("tasks.completerUids").get()'), 'doc("").get()');
  });

  test("a template loses its body, substitutions included", () => {
    assert.equal(stripSource("const k = `a:${b}`; c();"), "const k = ``; c();");
  });

  test("comments become a single space and line breaks inside a block comment are kept", () => {
    assert.equal(stripSource("a(); // x\nb();"), "a();  \nb();");
    assert.equal(stripSource("a(); /* one\ntwo */ b();"), "a();  \n b();");
  });

  test("a // inside a string was never a comment here either", () => {
    assert.equal(stripSource('go("https://example.com"); after();'), 'go(""); after();');
  });
});

describe("across the tree, keepStrings never sees less code than the ordinary mode", () => {
  // The two modes differ only in what they write for a string's body. With
  // every string and template body taken out of both, what is left has to be
  // the same text. If keepStrings ever loses its place again, this is where
  // it shows, on a real file, whichever file it is.
  const emptied = (text) => stripSource(text);

  function* walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) yield full;
    }
  }

  test("every .ts and .tsx file under src reads the same in both modes once strings are emptied", () => {
    const desynced = [];
    let files = 0;
    for (const file of walk(join(REPO_ROOT, "src"))) {
      files += 1;
      const source = readFileSync(file, "utf8");
      if (emptied(keep(source)) !== emptied(source)) {
        desynced.push(relative(REPO_ROOT, file).split("\\").join("/"));
      }
    }
    assert.ok(files > 500, `only ${files} files were walked`);
    assert.deepEqual(desynced, [], "keepStrings lost its place in these files");
  });
});
