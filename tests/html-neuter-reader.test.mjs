/**
 * The HTML neuterer reads its input once, and what it writes is safe whatever
 * it read.
 *
 * Run with `npm test` (Node's built-in runner, no emulator, no credentials).
 *
 * `neuterRichTextHtml` (src/lib/firestore/coursePages.ts) used to find tags and
 * attributes with two regular expressions, each of which could match the same
 * text in more than one way. A backtracking engine tries every way before it
 * gives up, so a short stored value made of quote characters held the request,
 * and the public page that reads it back, for longer than anybody would wait.
 * The two patterns are now readers that only move forward.
 *
 * Replacing the tokeniser of a sanitiser is the kind of change that fixes one
 * thing and opens another, so this file holds four things:
 *
 *  1. SAME ANSWER on well-formed input. The implementation it replaced is kept
 *     below as a model, and the two are compared over a hand-written corpus
 *     and several thousand generated documents.
 *  2. SAFE OUTPUT on any input. Several thousand strings of markup soup, each
 *     checked against a statement of what the output may contain that does not
 *     depend on how the input was read.
 *  3. TIME. Every family of input that made the old patterns slow, at two
 *     hundred thousand characters, inside a bound a linear reader meets with
 *     room to spare and a quadratic one misses by minutes.
 *  4. THE EDGES where the new reader deliberately differs from the old one,
 *     written down so the difference is a decision.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createLoader } from "./lib/tsLoader.mjs";
import { timeBoxed } from "./lib/timeBox.mjs";

const { loadTs } = createLoader();
const { neuterRichTextHtml, SAFE_HREF } = await loadTs("lib/firestore/coursePages.ts");

// ---------------------------------------------------------------------------
// The implementation this replaced, kept as a model. Only ever run on
// well-formed input: on anything else it is the bug.
// ---------------------------------------------------------------------------

const DROP_WITH_CONTENT =
  /<(script|style|title|textarea|noscript|iframe|object|embed|template|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "code", "pre", "blockquote",
  "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "a", "span",
]);
const ALLOWED_ATTRS = { a: new Set(["href", "title"]) };
const OLD_ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
const OLD_TAG = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;
const escapeAngles = (text) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttrValue = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function oldKeptAttributes(tag, rawAttrs) {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return "";
  let out = "";
  for (const match of rawAttrs.matchAll(OLD_ATTR)) {
    const name = match[1].toLowerCase();
    if (!allowed.has(name)) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    const cleaned = value.replace(/[\u0000- ]/g, "");
    if (name === "href" && !SAFE_HREF.test(cleaned)) continue;
    out += ` ${name}="${escapeAttrValue(cleaned)}"`;
  }
  return out;
}

function oldNeuter(raw) {
  const stripped = raw.replace(DROP_WITH_CONTENT, "");
  let out = "";
  let cursor = 0;
  OLD_TAG.lastIndex = 0;
  let match;
  while ((match = OLD_TAG.exec(stripped)) !== null) {
    out += escapeAngles(stripped.slice(cursor, match.index));
    cursor = OLD_TAG.lastIndex;
    const name = match[1].toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;
    out += match[0].startsWith("</") ? `</${name}>` : `<${name}${oldKeptAttributes(name, match[2])}>`;
  }
  out += escapeAngles(stripped.slice(cursor));
  return out;
}

// ---------------------------------------------------------------------------
// A generator that can be replayed: the same seed is the same documents.
// ---------------------------------------------------------------------------

function seeded(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { pick: (list) => list[Math.floor(next() * list.length)], int: (n) => Math.floor(next() * n) };
}

const TAG_NAMES = ["p", "strong", "em", "a", "ul", "li", "h2", "span", "div", "img", "table", "b", "code", "section", "font", "P", "A", "Strong"];
const TEXTS = [
  "Any student, no prerequisites.", "5 < 6", "a > b", "R&D", "&amp;", "&lt;script&gt;", "it's", 'she said "hi"',
  "", " ", "\n", "Six weeks", "x = y", "100%", "a/b", "&#60;", "café", " ",
];
const ATTR_NAMES = ["href", "title", "class", "style", "onclick", "onerror", "target", "rel", "id", "data-x", "HREF", "Title", "src", "download"];
const ATTR_VALUES = [
  "https://naisi.uk/courses", "http://example.org/a?b=1", "mailto:hello@naisi.uk", "/courses", "#top", "//elsewhere.example/x",
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "noopener noreferrer", "_blank",
  "Catalogue", "a > b", "it's", "x y z", "", "1", "color:red", "alert(1)",
];

/** One well-formed attribute: a balanced quoted value, or an unquoted one with nothing in it that needs quotes. */
function attribute(r) {
  const name = r.pick(ATTR_NAMES);
  const kind = r.int(10);
  if (kind === 0) return ` ${name}`; // bare
  const value = r.pick(ATTR_VALUES);
  const eq = r.pick(["=", "=", "=", " = ", "= ", " ="]);
  if (kind <= 5) return ` ${name}${eq}"${value.replace(/"/g, "")}"`;
  if (kind <= 7) return ` ${name}${eq}'${value.replace(/'/g, "")}'`;
  const bare = value.replace(/[\s"'<>]/g, "");
  return bare ? ` ${name}=${bare}` : ` ${name}=""`;
}

/** A document whose tags all close and whose quotes all balance: the old reader's home ground. */
function wellFormed(r) {
  let html = "";
  const pieces = 1 + r.int(14);
  for (let i = 0; i < pieces; i += 1) {
    const kind = r.int(12);
    if (kind <= 3) html += r.pick(TEXTS).replace(/<(?=[a-zA-Z/])/g, "< ");
    else if (kind <= 7) {
      const name = r.pick(TAG_NAMES);
      let attrs = "";
      for (let k = r.int(4); k > 0; k -= 1) attrs += attribute(r);
      html += `<${name}${attrs}${r.pick(["", "", " ", "/", " /"])}>`;
    } else if (kind <= 9) html += `</${r.pick(TAG_NAMES)}${r.pick(["", " ", ' x="1"'])}>`;
    else if (kind === 10) html += r.pick(["<script>alert(1)</script>", "<style>p{}</style>", "<svg><a/></svg>", "<iframe src=x></iframe>", "<SCRIPT>x</SCRIPT >"]);
    else html += r.pick(["<!-- a comment -->", "<br>", "<br/>", "<hr />", "< p>", "<3", "<>", "</>", "<!doctype html>"]);
  }
  return html;
}

/** Markup soup: nothing about it is promised. */
const SOUP = ["<", ">", '"', "'", "=", "/", " ", "\n", "\t", "a", "p", "href", "title", "onclick", "onerror", "script", "style", "javascript:", "https://x", "&", "&lt;", ";", "x", "<a ", "<p>", "</a>", "</", '="', "='", "<script>", "</script>", "<!--", "-->"];
function soup(r) {
  let out = "";
  for (let k = 1 + r.int(40); k > 0; k -= 1) out += r.pick(SOUP);
  return out;
}

// ---------------------------------------------------------------------------
// What the output may contain, stated without reference to how input is read
// ---------------------------------------------------------------------------

const NAMES = [...ALLOWED_TAGS].join("|");
// A tag this function builds: a closing tag, or an opening tag whose only
// attributes are href and title on `a`, each double-quoted with no quote or
// angle bracket that could end it early.
const BUILT_TAG = new RegExp(`</(?:${NAMES})>|<(?:${NAMES})>|<a(?: (?:href|title)="[^"<]*")+>`, "g");

function assertSafe(output, input) {
  const context = `\n  input:  ${JSON.stringify(input.slice(0, 300))}\n  output: ${JSON.stringify(output.slice(0, 300))}`;
  const text = output.replace(BUILT_TAG, "");
  assert.ok(!text.includes("<"), `a "<" reached the output outside a tag this function built${context}`);
  assert.ok(!text.includes(">"), `a ">" reached the output outside a tag this function built${context}`);
  for (const [tag] of output.matchAll(BUILT_TAG)) {
    for (const [, name, value] of tag.matchAll(/ (href|title)="([^"]*)"/g)) {
      assert.ok(!/[\u0000- ]/.test(value), `a control character or space survived in ${name}${context}`);
      if (name === "href") assert.match(value, /^(https?:|mailto:|\/|#)/i, `an href outside the allowlist${context}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Same answer on well-formed input
// ---------------------------------------------------------------------------

describe("on well-formed input the new reader gives the old reader's answer", () => {
  const written = [
    "",
    "plain text",
    "<p>Any student, <strong>no prerequisites</strong>.</p>",
    '<h2>Who it is for</h2><ul><li>Six weeks</li><li>One session a week</li></ul><p><a href="https://naisi.uk/courses" title="Catalogue">the catalogue</a></p>',
    '<p><a target="_blank" rel="noopener noreferrer nofollow" class="link" href="https://example.org/a?b=1">out</a></p>',
    "<a href='https://naisi.uk' title='single quotes'>x</a>",
    "<a href=https://naisi.uk title=bare>x</a>",
    '<A HREF="HTTPS://NAISI.UK" TITLE="Upper">x</A>',
    '<a href = "https://naisi.uk" title= "spaced">x</a>',
    '<a download href="/courses">x</a>',
    '<a href="/a" href="/b">two hrefs</a>',
    '<a title="a > b" href="#top">a quoted bracket</a>',
    '<a href="java\nscript:alert(1)">x</a>',
    '<img src="x" onerror="alert(1)"><p onclick="alert(1)">hi</p>',
    "<div><span>kept</span></div>",
    "line<br>break<br/>and<hr />rule",
    "</p x=\"1\"></div>",
    "5 < 6 and 7 > 3",
    "<!-- a comment --><p>after</p>",
    "<scr<script>x</script>ipt>alert(1)</script>",
    "<svg><script>alert(1)</script></svg><style>p{}</style>",
    "R&D &amp; &lt;b&gt; &#60;",
    "<pfoo>not a p</pfoo>",
    "<p\n class=\"x\"\n>multi-line tag</p>",
  ];

  test("over a hand-written corpus", () => {
    for (const html of written) assert.equal(neuterRichTextHtml(html), oldNeuter(html), JSON.stringify(html));
  });

  test("over four thousand generated documents", () => {
    const r = seeded(20261002);
    for (let i = 0; i < 4000; i += 1) {
      const html = wellFormed(r);
      assert.equal(neuterRichTextHtml(html), oldNeuter(html), `document ${i}: ${JSON.stringify(html)}`);
    }
  });

  test("the generator reaches what it is meant to reach", () => {
    // A generator that never produced a link would prove nothing about links.
    const r = seeded(20261002);
    const all = Array.from({ length: 4000 }, () => neuterRichTextHtml(wellFormed(r))).join("\n");
    for (const needle of ['<a href="https://naisi.uk/courses"', ' title="', "<strong>", "</li>", "&lt;", "&gt;", '<a href="mailto:']) {
      assert.ok(all.includes(needle), `no generated document produced ${needle}`);
    }
    assert.doesNotMatch(all, /href="(?:javascript|data|vbscript):/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Safe output on any input
// ---------------------------------------------------------------------------

describe("the output is safe whatever the input", () => {
  test("over six thousand strings of markup soup", () => {
    const r = seeded(77);
    for (let i = 0; i < 6000; i += 1) {
      const html = soup(r);
      assertSafe(neuterRichTextHtml(html), html);
    }
  });

  test("over the generated well-formed documents too", () => {
    const r = seeded(5);
    for (let i = 0; i < 2000; i += 1) {
      const html = wellFormed(r);
      assertSafe(neuterRichTextHtml(html), html);
    }
  });

  test("over the ways a tag is usually smuggled", () => {
    for (const html of [
      '<a href="javascript:alert(1)">x</a>',
      "<a href=javascript:alert(1)>x</a>",
      "<a href='  javascript:alert(1)'>x</a>",
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="jav\tascript:alert(1)">x</a>',
      '<a title="x" onmouseover="alert(1)" href="#">x</a>',
      '<a title=\'"><script>alert(1)</script>\'>x</a>',
      '<a title="\'><img src=x onerror=alert(1)>">x</a>',
      '<a href="https://x" title="><svg onload=alert(1)>">x</a>',
      "<p><<script>script>alert(1)<</script>/script></p>",
      "<p title='unclosed><script>alert(1)</script>",
      '<a href="https://x"onclick="alert(1)">x</a>',
      "<a/href=\"javascript:alert(1)\"/title=x>y</a>",
      "<img src=x onerror=alert(1)//",
      "<<p>>",
      "<p <script>alert(1)</script>>",
      '<a href="https://x" title="a"b" onclick="alert(1)">x</a>',
      "<math><mi xlink:href=\"data:x,<script>alert(1)</script>\">",
      "<iframe srcdoc=\"<script>alert(1)</script>\">",
      "<p>ok</p><a href=\"x",
      "<a title=\"never closes>and then <b>bold</b>",
    ]) {
      const out = neuterRichTextHtml(html);
      assertSafe(out, html);
      // Said again in plain terms, so a mistake in assertSafe cannot hide one.
      assert.doesNotMatch(out, /<(?:script|img|svg|iframe|math)\b/i, html);
      assert.doesNotMatch(out, /<[a-z][^<>]*\son[a-z]+\s*=/i, html);
    }
  });

  test("reading the output again keeps it safe", () => {
    // The route neuters on write and the normaliser neuters again on read.
    const r = seeded(9);
    for (let i = 0; i < 2000; i += 1) {
      const html = soup(r);
      const twice = neuterRichTextHtml(neuterRichTextHtml(html));
      assertSafe(twice, html);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Time
// ---------------------------------------------------------------------------

describe("it reads its input once", () => {
  const N = 200_000;
  // Generous for a slow runner: a linear reader takes a few milliseconds here,
  // and the patterns it replaced take minutes on the quadratic families and do
  // not finish at all on the first three. Each family runs in a worker that is
  // stopped at the limit (tests/lib/timeBox.mjs), so a reader that has gone
  // slow again fails here by name instead of hanging the suite.
  const BOUND_MS = 1500;
  const LIMIT_MS = 6000;
  const MODULE = { kind: "call", module: "lib/firestore/coursePages.ts", fn: "neuterRichTextHtml" };

  // [prefix, repeated unit, suffix]
  const families = {
    'a tag followed by pairs of quotes ("" repeated)': ["<a", '""', ""],
    "a tag followed by a run of double quotes": ["<a ", '"', ""],
    "a tag followed by alternating quotes": ["<a ", "'\"", ""],
    "a tag followed by quoted values that never reach a bracket": ["<a ", '"x" ', ""],
    "tags opening inside quoted values, over and over": ["", '<a "', ""],
    "the same with both kinds of quote": ["", "<a '\"<a \"'", ""],
    "a run of opening brackets": ["", "<", ""],
    "a run of tag openers with no bracket to close them": ["", "<a", ""],
    "a run of closing-tag openers": ["", "</a", ""],
    "one tag with a very long attribute name": ["<a ", "a", ">"],
    "one tag with a very long run of bare attributes": ["<a ", "b ", ">"],
    "one tag with a very long run of equals signs": ["<a ", "=", ">"],
    "one tag with many attributes that have no value": ["<a ", "a= ", ">"],
    "one link with a value that never closes": ['<a href="', "x", ""],
    "one link with a very long unquoted value": ["<a href=", "x", ">"],
    "a run of script openers that never close": ["", "<script", ""],
    "a script closer followed by a long run of spaces, repeated": ["", `</script${" ".repeat(500)}`, ""],
    "many real tags": ["", "<p>x</p>", ""],
    "a run of ampersands": ["", "&", ""],
    "a run of closing brackets": ["", ">", ""],
    "a long ordinary document": [
      "",
      '<p>Any student, <strong>no prerequisites</strong>. <a href="https://naisi.uk/courses" title="Catalogue">the catalogue</a></p>',
      "",
    ],
  };

  for (const [name, [prefix, unit, suffix]] of Object.entries(families)) {
    test(`${name}: ${N.toLocaleString("en-GB")} characters inside ${BOUND_MS} ms`, async () => {
      const run = await timeBoxed({ ...MODULE, repeat: [prefix, unit, N, suffix] }, LIMIT_MS);
      assert.ok(run.finished, `still running after ${LIMIT_MS} ms and was stopped: the reader no longer reads this once`);
      assert.ok(run.took < BOUND_MS, `took ${Math.round(run.took)} ms`);
      assertSafe(run.result, `${prefix}${unit}${unit}${unit}...${suffix}`);
    });
  }

  test("the sixty characters that used to hold a request return at once", async () => {
    const run = await timeBoxed({ ...MODULE, input: `<A${'""'.repeat(29)}` }, LIMIT_MS);
    assert.ok(run.finished, "sixty characters of quotes did not return");
    assert.ok(run.took < 50, `took ${Math.round(run.took)} ms`);
  });

  test("the time limit itself works: a pattern that does backtrack is stopped and reported", async () => {
    // The pattern this reader replaced, on forty characters. If this ever
    // FINISHES, the box is not measuring what it claims to.
    const run = await timeBoxed(
      { kind: "regex-test", source: OLD_TAG.source, flags: "", input: `<a${'""'.repeat(40)}` },
      400,
    );
    assert.equal(run.finished, false);
  });
});

// ---------------------------------------------------------------------------
// 4. Where the new reader differs, on purpose
// ---------------------------------------------------------------------------

describe("a tag that never closes is text from there on", () => {
  test("a tag with no closing bracket", () => {
    assert.equal(neuterRichTextHtml('<p>ok</p><a href="x'), '<p>ok</p>&lt;a href="x');
    assert.equal(neuterRichTextHtml("before <strong and after"), "before &lt;strong and after");
  });

  test("a quoted value that never closes takes the rest of the input with it", () => {
    // The old reader went back and tried the quote as an ordinary character,
    // which is the retry that made it slow. This one does not go back.
    assert.equal(
      neuterRichTextHtml('<a title="never closes>and then <b>bold</b>'),
      '&lt;a title="never closes&gt;and then &lt;b&gt;bold&lt;/b&gt;',
    );
  });

  test("everything before the unclosed tag is read as usual", () => {
    assert.equal(neuterRichTextHtml('<h2>Title</h2><p onclick="x">body</p><em'), "<h2>Title</h2><p>body</p>&lt;em");
  });

  test("a bracket that opens nothing was never a tag, before or after", () => {
    for (const html of ["5 < 6", "<3", "< p>", "<>", "</>", "</ p>", "<!-- c -->", "a <", "<1a>"]) {
      assert.equal(neuterRichTextHtml(html), oldNeuter(html), html);
      assert.equal(neuterRichTextHtml(html), escapeAngles(html), html);
    }
  });
});

describe("attributes are read the way they were", () => {
  const link = (attrs) => neuterRichTextHtml(`<a${attrs}>x</a>`);

  test("quoted, unquoted, spaced and upper-case", () => {
    assert.equal(link(' href="https://naisi.uk"'), '<a href="https://naisi.uk">x</a>');
    assert.equal(link(" href='https://naisi.uk'"), '<a href="https://naisi.uk">x</a>');
    assert.equal(link(" href=https://naisi.uk"), '<a href="https://naisi.uk">x</a>');
    assert.equal(link(' href = "https://naisi.uk"'), '<a href="https://naisi.uk">x</a>');
    assert.equal(link(' HREF="https://naisi.uk" TITLE="T"'), '<a href="https://naisi.uk" title="T">x</a>');
  });

  test("a bare attribute is passed over and the next one is still read", () => {
    assert.equal(link(' download href="/courses"'), '<a href="/courses">x</a>');
    assert.equal(link(' hidden disabled title="t"'), '<a title="t">x</a>');
  });

  test("only href and title are kept, and an href has to be on the allowlist", () => {
    assert.equal(link(' class="c" style="s" onclick="o" target="_blank" href="#a"'), '<a href="#a">x</a>');
    assert.equal(link(' href="javascript:alert(1)" title="t"'), '<a title="t">x</a>');
    assert.equal(link(' href="data:text/html,x"'), "<a>x</a>");
  });

  test("a name that merely ends in href is not href", () => {
    assert.equal(link(' data-href="https://naisi.uk"'), "<a>x</a>");
    assert.equal(link(' xhref="https://naisi.uk"'), "<a>x</a>");
  });

  test("a value is escaped so it cannot end its own quotes", () => {
    assert.equal(link(" title='say \"hi\"'"), '<a title="say&quot;hi&quot;">x</a>');
    assert.equal(link(' title="a<b"'), '<a title="a&lt;b">x</a>');
  });
});
