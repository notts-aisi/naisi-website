"use client";

import { useState } from "react";
import type { InputHTMLAttributes } from "react";
import { Input } from "./Input";
import styles from "./PasswordInput.module.css";

/**
 * Password field with a reveal toggle on the right: a slashed, greyed-out eye
 * while hidden; click to reveal (slash drops, eye highlights). Same props as
 * Input minus `type` (managed here).
 */
export function PasswordInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">,
) {
  const [show, setShow] = useState(false);
  return (
    <div className={styles.wrap}>
      <Input {...props} type={show ? "text" : "password"} className={styles.input} />
      <button
        type="button"
        className={styles.toggle}
        data-shown={show}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        tabIndex={-1}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2 12c0 0 3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
          {!show && <line x1="4" y1="3.5" x2="20" y2="20.5" />}
        </svg>
      </button>
    </div>
  );
}
