/**
 * The loader the `npm test` suites use to execute TypeScript.
 *
 * ## Why this file exists
 *
 * Node 20 cannot import a `.ts` file, so every suite that executes shipping
 * code (rather than pattern-matching its source) transpiles it in memory with
 * the `typescript` devDependency, rewrites each import specifier to a data:
 * URL and imports the result. That dance was copied by hand into roughly fifty
 * files, and every copy was the same twenty lines with one difference: none of
 * them set a JSX option.
 *
 * That difference is not cosmetic. The moment a suite's module graph reaches an
 * email template, the loader hands `transpileModule` a `.tsx` with no JSX
 * setting, TypeScript parses `<Section>` as a type assertion, and the whole
 * FILE dies with a bare `SyntaxError` at import time, before a single test
 * runs. It looks like a broken test file rather than a missing compiler
 * option, and the way out that everybody found was to stub the template: an
 * entry in the stub map whose only reason to exist was that the loader could
 * not read JSX. That happened twice while the worksheet routes were being
 * built (`tests/worksheet-routes.test.mjs` and the three scheduler suites,
 * which reach the templates through `registry.ts` importing every job by
 * value), which is two times more than a compiler flag should cost.
 *
 * So the loader lives here once, it sets `jsx: ReactJSX`, and a template on the
 * far side of a server helper is compiled and rendered for real:
 * `react/jsx-runtime` and `@react-email/components` are both installed.
 *
 * ## What it does
 *
 * `createLoader({ stubs })` returns `{ loadTs }`. `loadTs("lib/foo/bar.ts")`
 * takes a path relative to `src/` (an absolute path is taken as written, which
 * is how this loader's own suite reaches a fixture pair that has no business
 * living in `src/`), transpiles that module and everything it imports, and
 * returns the imported namespace. Resolution is:
 *
 *  - a key in the stub map, matched on the SPECIFIER STRING exactly as written
 *    in the source, replaced by an inline module. The key is compared before
 *    anything is resolved, so `"./send"` stubs that specifier from whichever
 *    file wrote it, and `"@/lib/firebase/admin"` stubs the alias rather than
 *    the file behind it;
 *  - `@/…` against `src/`, and `./…` / `../…` against the importing file, in
 *    both cases trying `.ts`, then `.tsx`, then the bare path when it already
 *    carries one of those two extensions, then `index.ts` / `index.tsx`. A
 *    directory is never accepted as a module: `@/lib/devBypass` is both a
 *    directory and a module, and taking the directory hands `readFileSync` an
 *    EISDIR rather than a module;
 *  - anything else through `import.meta.resolve`, so a real dependency
 *    (`react/jsx-runtime`, `@react-email/components`, `firebase-admin`) loads
 *    from `node_modules` for real. A specifier that will not resolve is left
 *    alone rather than thrown on, because the regex below reads strings and a
 *    string can look like an import. That swallow has a cost worth knowing
 *    about: a bare specifier naming a package that genuinely is not installed
 *    survives into the emitted source, so the failure arrives later as Node
 *    refusing a specifier inside a `data:` URL rather than as this loader
 *    naming the file that imported it. Read such an error as a missing
 *    dependency of the module you loaded.
 *
 * Each transpiled module is cached per loader, so a graph that reaches one
 * module twice imports one instance of it, and a module's identity (its
 * top-level state, its `globalThis` handles) behaves as it does in production.
 *
 * ## What it does NOT do
 *
 * It is not a bundler and it is not a typechecker. `transpileModule` compiles
 * one file at a time with no program behind it, so nothing here proves a type;
 * `npx tsc --noEmit` does that. There is no CSS, image or JSON handling: a
 * local specifier that resolves to anything but a `.ts` or a `.tsx` is refused
 * BY NAME (`"./thing.module.css" … is not TypeScript`), which is the correct
 * answer for a loader whose job is server code. The refusal is deliberate and
 * it is worth its own branch: the file is on disk, so accepting it would hand
 * `transpileModule` a stylesheet and the failure would surface as a parse
 * error inside a `data:` URL with nothing pointing back at the import. A suite
 * whose graph reaches a stylesheet or a JSON file stubs that specifier.
 *
 * It stubs NOTHING by itself. `server-only`, `next/server`,
 * `firebase-admin/firestore`, the Admin SDK handle, the session, the
 * impersonation guard, the transport: every door to the outside world is the
 * caller's to close, in the caller's own `STUBS` map, where a reader of that
 * suite can see what it faked. A shared default set would be a list of doors
 * that some suites want open, and the suite that wanted one open would have no
 * way to say so.
 *
 * A stub's source is used verbatim: it is not transpiled and its own
 * specifiers are not rewritten, so a stub cannot import anything (a data: URL
 * has no `node_modules` to resolve against). Write stubs as plain JavaScript
 * with no imports, which is what every existing one already is.
 *
 * ## The rule
 *
 * A NEW test file that executes TypeScript imports this loader. It does not
 * paste a copy. A copy is a file that cannot read JSX until somebody
 * rediscovers why, and the rule is enforced rather than asserted:
 * `tests/ts-loader.test.mjs` holds every suite carrying its own
 * `transpileModule` dance against a frozen list of the forty-three that exist
 * today, so a forty-fourth fails, and it fails any file that imports this
 * module and defines a loader of its own as well.
 *
 * Those forty-three are left alone deliberately: they work, their graphs do not
 * reach a `.tsx`, and a wholesale migration would be a large diff with no
 * failure behind it. They move when they next need to change, and the list
 * shrinks by a line when one does.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(REPO_ROOT, "src");

/**
 * Every `from "…"` and `import("…")` in the emitted JavaScript. It reads
 * strings rather than parsing modules, which is why an unresolvable specifier
 * is left alone instead of being an error.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\2/g;

/** The compiler, loaded once for every loader in the process. */
let tsc = null;

async function typescript() {
  if (!tsc) {
    try {
      tsc = (await import("typescript")).default;
    } catch (err) {
      throw new Error("the `typescript` devDependency is not installed. Run `npm install`.", {
        cause: err,
      });
    }
  }
  return tsc;
}

function dataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

/** Only these two are compiled. See `firstFile` for why the line is drawn. */
const TS_EXTENSION = /\.tsx?$/;

function isFile(path) {
  return existsSync(path) && !statSync(path).isDirectory();
}

/**
 * The extension candidates, in order, resolving to a TypeScript FILE and never
 * to a directory or to anything else.
 *
 * The extensions come first and the bare path is only accepted when it already
 * carries one of them, which rules out two different wrong answers. A
 * directory: `@/lib/devBypass` is both a directory and a module, and taking the
 * directory hands `readFileSync` an EISDIR instead of a module, which is what
 * happened the first time a scheduler suite loaded a job whose graph reaches
 * `session.ts`. And a file this loader cannot compile: `./thing.module.css`
 * exists, so accepting the bare path would feed a stylesheet to
 * `transpileModule` and the error would arrive as a parse failure inside a
 * `data:` URL, naming neither the stylesheet nor the module that imported it.
 * Refusing here lets the caller say which specifier it was.
 */
function firstFile(base) {
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    ...(TS_EXTENSION.test(base) ? [base] : []),
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** The path a local specifier points at, before extensions are tried. */
function localBase(specifier, fromFile) {
  return specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
}

/**
 * @param {object} [options]
 * @param {Map<string, string> | Array<[string, string]>} [options.stubs]
 *   Specifier to inline module source. See the note above about what a stub
 *   may contain.
 * @returns {{ loadTs: (relativeSrcPath: string) => Promise<Record<string, unknown>> }}
 */
export function createLoader({ stubs } = {}) {
  const STUBS = new Map(stubs ?? []);
  // Per loader, never shared: two suites in one process stub different doors,
  // and a shared cache would hand the second suite the first one's fakes.
  const graph = new Map();

  function stubUrl(key) {
    const cached = graph.get(key);
    if (cached) return cached;
    const url = dataUrl(STUBS.get(key));
    graph.set(key, url);
    return url;
  }

  async function transpileToDataUrl(file) {
    if (STUBS.has(file)) return stubUrl(file);
    const cached = graph.get(file);
    if (cached) return cached;

    const ts = await typescript();
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        // The whole reason this file exists. `ReactJSX` emits the automatic
        // runtime (`import { jsx } from "react/jsx-runtime"`), which needs no
        // `React` in scope, so a template that never imports React compiles
        // exactly as it does in the app. `.ts` files are untouched by it.
        jsx: ts.JsxEmit.ReactJSX,
      },
    });

    const rewrites = new Map();
    for (const [, , , specifier] of outputText.matchAll(SPECIFIER)) {
      if (rewrites.has(specifier)) continue;
      if (STUBS.has(specifier)) {
        rewrites.set(specifier, stubUrl(specifier));
      } else if (specifier.startsWith(".") || specifier.startsWith("@/")) {
        const base = localBase(specifier, file);
        const target = firstFile(base);
        if (!target) {
          // Two different failures, and telling them apart is the difference
          // between a minute and an afternoon. A stylesheet or a JSON file is
          // ON DISK, so "cannot resolve" would send the reader hunting for a
          // file that is sitting right there.
          throw new Error(
            isFile(base)
              ? `"${specifier}" imported from ${file} is not TypeScript. This loader compiles ` +
                `.ts and .tsx only, so stub that specifier in the suite's own map.`
              : `cannot resolve "${specifier}" imported from ${file}`,
          );
        }
        rewrites.set(specifier, await transpileToDataUrl(target));
      } else {
        // A string literal can look like an import to a regex: "su-import"
        // carries the word inside it. Anything unresolvable is left alone.
        try {
          rewrites.set(specifier, import.meta.resolve(specifier));
        } catch {
          // Not a module.
        }
      }
    }

    const rewritten = outputText.replace(SPECIFIER, (whole, prefix, quote, specifier) =>
      rewrites.has(specifier) ? `${prefix}${quote}${rewrites.get(specifier)}${quote}` : whole,
    );
    const url = dataUrl(rewritten);
    graph.set(file, url);
    return url;
  }

  return {
    /**
     * @param {string} relativeSrcPath a path under `src/`, extension optional.
     *   An absolute path is taken as written, for a fixture outside `src/`.
     */
    async loadTs(relativeSrcPath) {
      const base = isAbsolute(relativeSrcPath) ? relativeSrcPath : join(SRC, relativeSrcPath);
      const file = firstFile(base);
      if (!file) {
        throw new Error(
          isAbsolute(relativeSrcPath)
            ? `no module at ${relativeSrcPath}`
            : `no module at src/${relativeSrcPath}`,
        );
      }
      return import(await transpileToDataUrl(file));
    },
  };
}
