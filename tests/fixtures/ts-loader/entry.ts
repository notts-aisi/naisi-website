/**
 * The `.ts` half of the fixture pair described in `./Panel.tsx`.
 *
 * The import below carries NO extension, the way every local import in the app
 * is written, so the loader has to try `./Panel.ts`, miss, and then find
 * `./Panel.tsx`. An extension here would test a path the app never takes.
 */
import Panel from "./Panel";

export function panelFor(name: string) {
  return Panel({ name });
}
