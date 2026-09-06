/**
 * Props that are declared and then dropped.
 *
 * `StatusSelect` and `GraduationSelect` each declared `id` and `required` in
 * their `Props` type and destructured neither, so every caller handed over an
 * id that reached no element: the `<Field id="…">` label pointed at nothing,
 * clicking it focused no control, and the browser could not enforce a required
 * field. Nothing caught it, and nothing could. TypeScript checks the caller
 * against the declared prop and has no opinion on whether the component ever
 * reads it, ESLint's unused-vars rule only sees bindings that exist, and the
 * page looks identical either way.
 *
 * The guard therefore walks every component in `src` rather than the two that
 * were broken, which is the point: a fix for one component is a regression
 * test, and the next component to declare an `id` it never binds is written by
 * somebody who has not read this file. Only `.tsx` is read, because a props
 * type is a component's contract and components live in `.tsx`.
 *
 * ## What counts here
 *
 * `DOM_PROPS` is the set whose entire job is to reach an element and whose
 * absence is silent: no type error, no crash, nothing different on screen.
 * `value`, `onChange`, `children` and the rest announce themselves the moment
 * they are dropped, so they are not the class this is about and are not
 * listed. Add to the set, do not broaden it to every prop.
 *
 * ## And the forwarding itself
 *
 * Binding a prop is not the same as passing it on, so the last two tests pin
 * the chain the register form actually depends on: the two selects hand `id`
 * and `required` to `ResponsiveSelect`, and `ResponsiveSelect` puts both on
 * the native `<select>` rather than on the sheet shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "src");

const DOM_PROPS = new Set([
  "id",
  "htmlFor",
  "name",
  "required",
  "readOnly",
  "maxLength",
  "minLength",
  "pattern",
  "placeholder",
  "autoComplete",
  "inputMode",
  "ariaLabel",
  "ariaLabelledBy",
  "describedBy",
]);

/**
 * Props declarations this guard cannot read, each with the reason it is safe
 * to leave unread. Checked in both directions: an entry that becomes readable
 * fails here too, so the list cannot rot into a silent exemption.
 */
const UNREADABLE = new Map([
  [
    "src/features/tasks/components/CommentComposer.tsx:Props",
    "A union of CreateProps and EditProps, both declared in the same file and both read by this guard.",
  ],
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Index of the bracket closing the one at `open`, or -1. */
function closer(src, open, openChar, closeChar) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === openChar) depth++;
    else if (src[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Comments, strings and the `=>` of a function type all carry brackets that
 * would throw the member split off, so they go before it does.
 */
function stripNoise(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/=>/g, "= ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

/** Split on the separators that sit outside every bracket. */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of stripNoise(text)) {
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth--;
    if (depth === 0 && (ch === ";" || ch === ",")) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Member names of a type body: `id?: string` gives `id`. */
function memberNames(body) {
  const names = [];
  for (const part of topLevelParts(body)) {
    const m = /^(?:readonly\s+)?(\w+)\??\s*:/.exec(part);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Bindings of a destructuring pattern: `{ id, value: v, n = 1, ...rest }`. */
function patternNames(body) {
  const names = [];
  for (const part of topLevelParts(body)) {
    if (part.startsWith("...")) {
      names.push("...");
      continue;
    }
    const m = /^(\w+)\s*(?::|=|$)/.exec(part);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Members written on the right of a type alias, reading every object literal
 * in an intersection and giving up on a union.
 *
 * `HTMLAttributes<HTMLSpanElement> & { tone?: ChipTone }` is the common shape,
 * and only the literal half is written here: the other half's props come from
 * React's own DOM types and reach the element through the `{...rest}` spread
 * this guard already accepts. A union (`CreateProps | EditProps`) has no one
 * shape to read, so it is reported as unreadable rather than half-read.
 */
function readAliasMembers(src, from) {
  const members = [];
  let i = from;
  let sawObject = false;
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "{") {
      const end = closer(src, i, "{", "}");
      if (end < 0) return null;
      members.push(...memberNames(src.slice(i + 1, end)));
      sawObject = true;
      i = end + 1;
    } else {
      let depth = 0;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
        else if (c === ">" || c === ")" || c === "]" || c === "}") depth--;
        else if (depth === 0 && (c === "&" || c === "|" || c === ";" || c === "\n")) break;
      }
      if (src[i] === "|") return null;
    }
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "&") {
      i++;
      continue;
    }
    if (src[i] === "|") return null;
    break;
  }
  return sawObject ? members : null;
}

/** Every `type|interface *Props` in a file, with the body it can read. */
function propsTypes(src) {
  const found = [];
  const decl = /\b(?:type|interface)\s+(\w*Props)\b/g;
  let m;
  while ((m = decl.exec(src))) {
    let i = m.index + m[0].length;
    if (src[i] === "<") {
      const end = closer(src, i, "<", ">");
      if (end < 0) continue;
      i = end + 1;
    }
    while (/\s/.test(src[i])) i++;
    if (src[i] === "=") {
      const members = readAliasMembers(src, i + 1);
      if (members === null) found.push({ name: m[1], readable: false });
      else found.push({ name: m[1], readable: true, declaredAt: m.index, members });
      continue;
    }
    if (src.startsWith("extends", i)) {
      const brace = src.indexOf("{", i);
      if (brace < 0) continue;
      i = brace;
    }
    if (src[i] !== "{") {
      found.push({ name: m[1], readable: false });
      continue;
    }
    const end = closer(src, i, "{", "}");
    if (end < 0) {
      found.push({ name: m[1], readable: false });
      continue;
    }
    found.push({
      name: m[1],
      readable: true,
      declaredAt: m.index,
      members: memberNames(src.slice(i + 1, end)),
    });
  }
  return found;
}

/**
 * Where a type is used as a function parameter, and what that parameter binds.
 * An annotation somewhere other than a parameter list (`const p: Props = …`)
 * is not a component reading its props, so it is not counted as a use.
 */
function parameterUses(src, typeName, declaredAt) {
  const uses = [];
  const re = new RegExp(`:\\s*${typeName}\\b`, "g");
  let m;
  while ((m = re.exec(src))) {
    if (m.index === declaredAt) continue;
    const before = src.slice(0, m.index).trimEnd();
    if (before.endsWith("}")) {
      let depth = 0;
      let i = before.length - 1;
      for (; i >= 0; i--) {
        if (before[i] === "}") depth++;
        else if (before[i] === "{") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (i < 0) continue;
      const lead = before.slice(0, i).trimEnd();
      if (!lead.endsWith("(") && !lead.endsWith(",")) continue;
      uses.push({ bound: new Set(patternNames(before.slice(i + 1, before.length - 1))) });
      continue;
    }
    const named = /(\w+)$/.exec(before);
    if (!named) continue;
    const lead = before.slice(0, before.length - named[1].length).trimEnd();
    if (!lead.endsWith("(") && !lead.endsWith(",")) continue;
    uses.push({ object: named[1] });
  }
  return uses;
}

function scan() {
  const dropped = [];
  const unreadable = [];
  const unused = [];
  let checkedProps = 0;
  const checkedTypes = new Set();

  for (const file of walk(SRC)) {
    const rel = relative(REPO_ROOT, file);
    const src = readFileSync(file, "utf8");
    for (const type of propsTypes(src)) {
      if (!type.readable) {
        unreadable.push(`${rel}:${type.name}`);
        continue;
      }
      const domProps = type.members.filter((p) => DOM_PROPS.has(p));
      if (domProps.length === 0) continue;
      const uses = parameterUses(src, type.name, type.declaredAt);
      if (uses.length === 0) {
        unused.push(`${rel}:${type.name} (declares ${domProps.join(", ")})`);
        continue;
      }
      checkedProps += domProps.length;
      checkedTypes.add(`${rel}:${type.name}`);
      for (const use of uses) {
        for (const prop of domProps) {
          const bound = use.object
            ? new RegExp(`\\b${use.object}\\.${prop}\\b`).test(src)
            : use.bound.has(prop) || use.bound.has("...");
          if (!bound) dropped.push(`${rel}:${type.name}.${prop}`);
        }
      }
    }
  }
  return { dropped, unreadable, unused, checkedProps, checkedTypes };
}

const RESULT = scan();

test("every component binds the DOM props its own Props type declares", () => {
  assert.deepEqual(
    RESULT.dropped,
    [],
    `A props type declares one of ${[...DOM_PROPS].join(", ")} and the component never binds it, ` +
      `so callers pass it and nothing receives it. Destructure it and pass it to the element, ` +
      `or delete it from the type:\n  ${RESULT.dropped.join("\n  ")}`,
  );
});

test("a props type that declares a DOM prop is read by some component", () => {
  assert.deepEqual(
    RESULT.unused,
    [],
    `These props types declare a DOM prop but are never annotated onto a function parameter, ` +
      `so this guard cannot tell whether anything reads them. Give the type a component or ` +
      `drop the prop:\n  ${RESULT.unused.join("\n  ")}`,
  );
});

test("every props type this guard cannot read has a written reason", () => {
  assert.deepEqual(
    RESULT.unreadable.filter((entry) => !UNREADABLE.has(entry)),
    [],
    "A props type is not an object literal, so its members are invisible to this guard. " +
      "Add it to UNREADABLE with the reason nothing is lost by not reading it.",
  );
  assert.deepEqual(
    [...UNREADABLE.keys()].filter((entry) => !RESULT.unreadable.includes(entry)),
    [],
    "UNREADABLE names a props type this guard now reads, or one that no longer exists. Drop the entry.",
  );
});

// A floor under the walk. Without it a parser that silently stops matching
// reports zero dropped props and reads as a pass.
test("the guard still reads the tree it claims to read", () => {
  assert.ok(
    RESULT.checkedProps >= 25,
    `Only ${RESULT.checkedProps} DOM props were checked across ${RESULT.checkedTypes.size} types. ` +
      "That is far below the tree as it stood when this guard was written, so the parser has " +
      "probably stopped matching rather than the tree having shrunk.",
  );
  for (const type of [
    "src/components/ui/StatusSelect.tsx:Props",
    "src/components/ui/GraduationSelect.tsx:Props",
  ]) {
    assert.ok(
      RESULT.checkedTypes.has(type),
      `${type} is the component this guard was written for and it was not among the types checked.`,
    );
  }
});

function read(rel) {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

test("StatusSelect and GraduationSelect hand id and required to the control", () => {
  const status = read("src/components/ui/StatusSelect.tsx");
  assert.match(
    status,
    /<ResponsiveSelect[\s\S]*?\bid=\{id\}/,
    "StatusSelect binds id but does not pass it to ResponsiveSelect, so the caller's <Field id> label points at nothing.",
  );
  assert.match(
    status,
    /<ResponsiveSelect[\s\S]*?\brequired=\{required\}/,
    "StatusSelect binds required but does not pass it on, so the browser cannot enforce the field.",
  );

  const graduation = read("src/components/ui/GraduationSelect.tsx");
  // One id across two controls: two elements cannot share it, and the field's
  // label has to focus the first of the pair.
  assert.equal(
    graduation.match(/\bid=\{id\}/g)?.length,
    1,
    "GraduationSelect renders two selects and exactly one of them may carry the field's id.",
  );
  assert.equal(
    graduation.match(/\brequired=\{required\}/g)?.length,
    2,
    "Both halves of GraduationSelect are required: a month without a year emits the empty string.",
  );
  // The e2e profile step locates these by exact aria-label
  // (select[aria-label='Month'] and ='Year'), so renaming one is a spec change.
  for (const label of ["Month", "Year"]) {
    assert.ok(
      graduation.includes(`ariaLabel="${label}"`),
      `GraduationSelect's ${label} control lost its aria-label. tests/e2e/applicant-signup.spec.mjs locates it by that exact string.`,
    );
  }
});

test("ResponsiveSelect puts id and required on the native select", () => {
  const src = read("src/components/ui/ResponsiveSelect.tsx");
  const nativeAt = src.indexOf("<Select");
  const sheetAt = src.indexOf("<Dropdown");
  assert.ok(
    nativeAt > 0 && sheetAt > nativeAt,
    "ResponsiveSelect no longer renders the native <Select> before the <Dropdown> sheet, which is how this test tells the two apart.",
  );
  const native = src.slice(nativeAt, sheetAt);
  assert.match(
    native,
    /\bid=\{id\}/,
    "The native select lost the id, so a caller's <label htmlFor> points at nothing.",
  );
  assert.match(
    native,
    /\brequired=\{[^}]*\brequired\b[^}]*\}/,
    "The native select lost required, so the browser stops enforcing every field that asks for it.",
  );
});
