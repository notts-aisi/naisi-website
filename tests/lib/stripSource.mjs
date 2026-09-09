/**
 * Read a TypeScript file as CODE ONLY: comments removed, string and template
 * bodies emptied, everything else left where it was.
 *
 * ## Why a tokeniser rather than four regexes
 *
 * The four-regex version (block comments, then whole-line comments, then
 * templates, then quotes) is what several guards here started with, and it
 * desyncs the moment a file carries a TRAILING comment with an apostrophe in
 * it. `// don't` survives the whole-line rule, and the single-quote pass then
 * reads that apostrophe as the start of a string and swallows everything to
 * the next one. On `src/app/api/unsubscribe/route.ts` that turned a 15,837
 * character file into 4,705 characters and made both of its handlers
 * invisible, which a scanner reports as "nothing to see" rather than as a
 * failure. A guard that silently stops looking is the failure mode these
 * tests exist to remove, so the reading is done once, properly, here.
 *
 * ## What it does
 *
 * One pass, five states: code, line comment, block comment, quoted string,
 * template literal. Comments become a single space, so two tokens either side
 * of one do not fuse. A string keeps its quotes and loses its body, so
 * `"tasks.completerUids"` reads as `""` and cannot be mistaken for a field
 * access, while the expression around it keeps its shape. Template
 * substitutions are dropped with the rest of the body: nothing here needs to
 * read inside one, and keeping them would mean tracking nested braces.
 *
 * Offsets are NOT preserved (comments collapse), so a caller that needs to
 * map a hit back to a line number should split the result rather than index
 * the original.
 *
 * Regex literals are deliberately NOT tracked. Telling `/` division from a
 * regex needs the parser context this file does not have, and the cost of the
 * simplification is bounded: a regex containing a quote or a `//` can still
 * desync a file. `assertReadable` below is the answer to that rather than a
 * cleverer guess: a caller can ask whether the result is plausible for the
 * input and fail loudly if it is not.
 */

const CODE = 0;
const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const STRING = 3;
const TEMPLATE = 4;

/**
 * `stripSource(src)` empties string and template bodies as well as removing
 * comments. `stripSource(src, { keepStrings: true })` removes only the
 * comments, which is what a caller wants when it is looking for a literal that
 * contains a string or a template (`rateLimit(\`events:rsvp:ip:${ip}\`)`), and
 * still cannot be fooled by a mention of that literal in a comment.
 */
export function stripSource(source, { keepStrings = false } = {}) {
  let state = CODE;
  let quote = "";
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (state === CODE) {
      if (c === "/" && next === "/") {
        state = LINE_COMMENT;
        i += 1;
        out += " ";
      } else if (c === "/" && next === "*") {
        state = BLOCK_COMMENT;
        i += 1;
        out += " ";
      } else if ((c === '"' || c === "'") && !keepStrings) {
        state = STRING;
        quote = c;
        out += c;
      } else if (c === "`" && !keepStrings) {
        state = TEMPLATE;
        out += c;
      } else {
        out += c;
      }
      continue;
    }
    if (state === LINE_COMMENT) {
      if (c === "\n") {
        state = CODE;
        out += "\n";
      }
      continue;
    }
    if (state === BLOCK_COMMENT) {
      if (c === "*" && next === "/") {
        state = CODE;
        i += 1;
      } else if (c === "\n") {
        // Keep the line count, so a caller that splits on newlines still sees
        // the same lines the file has.
        out += "\n";
      }
      continue;
    }
    if (state === STRING) {
      if (c === "\\") {
        i += 1;
      } else if (c === quote) {
        state = CODE;
        out += c;
      } else if (c === "\n") {
        // An unterminated string: the file does not compile, but a scanner
        // that swallowed the rest of it would report silence. Come back to
        // code at the line break.
        state = CODE;
        out += "\n";
      }
      continue;
    }
    // TEMPLATE
    if (c === "\\") {
      i += 1;
    } else if (c === "`") {
      state = CODE;
      out += c;
    } else if (c === "\n") {
      out += "\n";
    }
  }
  return out;
}

/**
 * Fail loudly when a file reads as far smaller than it is.
 *
 * Every desync this file exists to prevent shows up the same way: the result
 * collapses. A source that is mostly prose (a module with a long header
 * comment) legitimately shrinks a lot, so the floor is generous and the point
 * is only to catch a collapse, not to measure anything.
 */
export function assertReadable(source, stripped, label, assert) {
  const codeLines = stripped.split("\n").filter((line) => line.trim().length > 0).length;
  assert.ok(
    codeLines > 0,
    `${label} read as no code at all. The source reader has desynced; see tests/lib/stripSource.mjs.`,
  );
  assert.ok(
    stripped.length >= Math.min(200, source.length) * 0.02,
    `${label} read as ${stripped.length} characters out of ${source.length}. That is a ` +
      "collapse, not a comment-heavy file: the source reader has desynced.",
  );
}
