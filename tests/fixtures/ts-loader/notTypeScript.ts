/**
 * A fixture whose only job is to import something the loader cannot compile.
 *
 * A stylesheet is the everyday version of that: 241 modules in `src` import
 * one, and every client component's graph reaches one within a step or two.
 * The file EXISTS, which is the trap the loader's refusal exists to avoid, so
 * `tests/ts-loader.test.mjs` checks the error names the specifier rather than
 * arriving later as a parse failure with a stylesheet in it.
 */
import styles from "./panel.module.css";

export const panelClassName = styles.panel;
