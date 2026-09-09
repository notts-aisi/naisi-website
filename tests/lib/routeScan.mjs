/**
 * Reading a route file as a set of HANDLERS, done once.
 *
 * Two guards ask questions about the body of every exported handler under
 * `src/app/api`: `tests/public-write-gating.test.mjs` asks whether an
 * anonymous caller reaches it, `tests/gate-before-data.test.mjs` asks what it
 * reads before it proves who is calling. Both need the same reading: which
 * functions a file exports as handlers, where each body starts and ends, what
 * the file imports and what it defines at module scope. The first guard
 * carried its own copy of that reading, and the second was about to copy it
 * again, which is how `tests/lib/stripSource.mjs` came to exist: four guards
 * each with their own comment stripper, one of which desynced on an
 * apostrophe. So the reading lives here.
 *
 * Everything here works on source that has been through `stripSource`, so a
 * brace in a string or a comment cannot open a body that is not there. The
 * one thing it deliberately does NOT do is understand TypeScript: the
 * parameter list of a handler is skipped by bracket matching so that a type
 * literal in it (`ctx: { params: Promise<{ id: string }> }`) is not taken for
 * the body, and that is as far as the parsing goes.
 */

/** Every method Next will route to a handler. */
export const HTTP_METHOD = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";

/**
 * A handler exported in a form these scanners cannot read.
 *
 * Next accepts several: `export const POST = ...`, `export { handler as POST }`,
 * `export { POST }` after a local declaration, `export { POST } from "./x"` and
 * `export * from "./x"`. The scanners only understand `export async function`,
 * which is what every route file uses today, and a route that used another
 * form would be invisible to them rather than reported by them. So the form
 * itself is checked, in every one of those spellings and for `HEAD` and
 * `OPTIONS` as well: a handler exported any other way fails, and whoever
 * wrote it decides between changing the form and teaching the scanner.
 */
export const UNREADABLE_EXPORT = new RegExp(
  [
    `export\\s+(?:const|let|var)\\s+(?:${HTTP_METHOD})\\b`,
    `export\\s*\\{[^}]*\\b(?:${HTTP_METHOD})\\b[^}]*\\}`,
    `export\\s*\\*\\s*from`,
  ].join("|"),
);

const HANDLER = new RegExp(`export\\s+async\\s+function\\s+(${HTTP_METHOD})\\s*\\(`, "g");

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every `route.ts` under `dir`, depth first, in directory order. */
export function* walkRoutes(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkRoutes(full);
    else if (entry === "route.ts") yield full;
  }
}

/** Index of the bracket that closes the one at `openIdx`, or -1. */
export function balancedEnd(source, openIdx, open = "(", close = ")") {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The balanced `(...)` starting at `openIdx`, without its brackets. */
export function balancedParens(source, openIdx) {
  const end = balancedEnd(source, openIdx);
  return end < 0 ? "" : source.slice(openIdx + 1, end);
}

/**
 * The span of the function body whose declaration starts at `from`: the
 * offsets of the text between its outer braces, and that text.
 *
 * The parameter list is skipped FIRST. `ctx: { params: Promise<{ id: string }> }`
 * puts a brace before the body, and taking that brace reads a type literal as
 * the function: every route in the tree then looked ungated, which is the
 * shape of failure a guard must not have.
 */
export function functionSpan(source, from) {
  const paren = source.indexOf("(", from);
  if (paren < 0) return null;
  const afterParams = balancedEnd(source, paren);
  if (afterParams < 0) return null;
  const open = bodyOpen(source, afterParams + 1);
  if (open < 0) return null;
  const close = balancedEnd(source, open, "{", "}");
  if (close < 0) return null;
  return { start: open + 1, end: close, text: source.slice(open + 1, close) };
}

/**
 * The `{` that opens a function body, skipping a return type annotation.
 *
 * `async function prepareWrite(...): Promise<{ ok: true } | { ok: false }> {`
 * puts three braces between the parameters and the body. The first one after
 * a colon, a bar, an ampersand, a comma, an equals sign or an opening bracket
 * is a type literal and is skipped whole; a brace inside angle brackets is a
 * type literal too. The body is the first brace at depth zero that follows
 * something a type can end with. An arrow's `=>` is not a closing angle
 * bracket.
 */
function bodyOpen(source, i) {
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== ":") return source.indexOf("{", i);
  let depth = 0;
  let prev = ":";
  for (i += 1; i < source.length; i += 1) {
    const c = source[i];
    if (/\s/.test(c)) continue;
    if (c === "(" || c === "[" || c === "<") {
      depth += 1;
      prev = c;
    } else if (c === ")" || c === "]") {
      depth -= 1;
      prev = c;
    } else if (c === ">") {
      if (source[i - 1] === "=") prev = "=>";
      else {
        depth -= 1;
        prev = c;
      }
    } else if (c === "{") {
      if (depth > 0 || prev === "=>" || /[:|&,=(<]$/.test(prev)) {
        const end = balancedEnd(source, i, "{", "}");
        if (end < 0) return -1;
        i = end;
        prev = "}";
      } else {
        return i;
      }
    } else {
      prev = c;
    }
  }
  return -1;
}

/** The body text of the handler whose `export async function` starts at `from`. */
export function handlerBody(source, from) {
  return functionSpan(source, from)?.text ?? null;
}

/** Every exported handler in a stripped route source, in file order. */
export function exportedHandlers(source) {
  const found = [];
  HANDLER.lastIndex = 0;
  let match;
  while ((match = HANDLER.exec(source)) !== null) {
    found.push({ method: match[1], index: match.index, span: functionSpan(source, match.index) });
  }
  return found;
}

/** Brace depth at each character of `body`, relative to the body itself. */
export function braceDepths(body) {
  const depths = new Array(body.length);
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{") {
      depths[i] = depth;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      depths[i] = depth;
    } else {
      depths[i] = depth;
    }
  }
  return depths;
}

/**
 * Does this condition read as "there is no session"?
 *
 * The shapes the tree actually uses: a negation, a null comparison, a refusal
 * object the gate returned (`gate.error`, `"error" in gate`), and the
 * `instanceof NextResponse` the applicant gate uses. Deliberately NOT "the
 * condition mentions the variable": `if (viewer.role === "admin")` mentions it
 * and is a branch, not a refusal, and treating a branch as a gate is the
 * direction that hides an open route.
 */
export function readsAsAbsence(condition, variable) {
  const v = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\w.])!\\s*${v}\\b` +
      `|\\b${v}\\s*={2,3}\\s*null\\b` +
      `|\\b${v}\\s*\\.\\s*error\\b` +
      `|""\\s+in\\s+${v}\\b` +
      `|\\b${v}\\s+instanceof\\b`,
  ).test(condition);
}

/**
 * What a stripped module declares at its top level: every imported name with
 * the specifier it came from, and every function defined at column zero
 * (`function f`, `async function f`, `const f = (...) =>`, `const f = async
 * (...) =>`) with the span of its body, so a scanner can read a helper the
 * handler calls the way it reads the handler.
 *
 * `source` is the string-emptied reading the spans index into. The import
 * specifiers are strings, so they are read from `withStrings`, the same
 * source with its strings kept (`stripSource(raw, { keepStrings: true })`);
 * a caller that passes only `source` gets no specifiers at all.
 */
export function moduleScope(source, withStrings = source) {
  const imports = new Map();
  for (const match of withStrings.matchAll(
    /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g,
  )) {
    for (const piece of match[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !piece.trim().startsWith("type ")) imports.set(name, match[2]);
    }
  }
  for (const match of withStrings.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*["']([^"']+)["']/g,
  )) {
    imports.set(match[1], match[2]);
  }
  for (const match of withStrings.matchAll(
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']/g,
  )) {
    imports.set(match[1], match[2]);
  }

  const locals = new Map();
  for (const match of source.matchAll(
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/gm,
  )) {
    const span = functionSpan(source, match.index + match[0].length - 1);
    if (span) locals.set(match[1], span);
  }
  for (const match of source.matchAll(
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>\s*/gm,
  )) {
    const at = match.index + match[0].length;
    if (source[at] === "{") {
      const close = balancedEnd(source, at, "{", "}");
      if (close > at) locals.set(match[1], { start: at + 1, end: close, text: source.slice(at + 1, close) });
    } else {
      // An expression body: read to the end of the statement.
      let end = at;
      let depth = 0;
      for (; end < source.length; end++) {
        const c = source[end];
        if (c === "(" || c === "[" || c === "{") depth += 1;
        else if (c === ")" || c === "]" || c === "}") depth -= 1;
        else if ((c === ";" || c === "\n") && depth === 0) break;
      }
      locals.set(match[1], { start: at, end, text: source.slice(at, end) });
    }
  }
  return { imports, locals };
}

/**
 * A route that reads as almost nothing has not been read. Throws with the
 * path so the failure names the file rather than reporting silence.
 */
export function assertReadableSource(raw, source, path) {
  const codeLines = source.split("\n").filter((line) => line.trim().length > 0).length;
  if (codeLines === 0 || source.length < Math.min(200, raw.length) * 0.02) {
    throw new Error(
      `${path} read as ${source.length} characters out of ${raw.length}. The source reader ` +
        "has desynced; see tests/lib/stripSource.mjs.",
    );
  }
}
