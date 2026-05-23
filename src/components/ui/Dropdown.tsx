"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
// useEffect kept for click-outside + scroll/resize listeners (no setState
// inside those effects so they don't trip set-state-in-effect).
import { createPortal } from "react-dom";
import { maxWidth, type BreakpointKey } from "@/theme/breakpoints";
import styles from "./Dropdown.module.css";

/**
 * Custom Dropdown — replacement for native <select> on the task surfaces.
 *
 * Renders a trigger button with the current selected label + chevron. When
 * opened:
 * - Above `--bp-md` it portals a popover anchored under the trigger, with
 *   auto-flip above if the menu would overflow the viewport bottom.
 * - Below `--bp-md` it portals a bottom sheet (scrim + slide-up panel +
 *   Cancel row), the native pattern on iOS/Android.
 *
 * Both shapes share the option list and ARIA-1.2 combobox semantics
 * (focus stays on the trigger; aria-activedescendant on the trigger
 * points to the keyboard-active option). Keyboard nav matches native
 * <select>: ArrowUp / ArrowDown / Home / End / Enter / Escape / type-to-
 * jump-by-prefix.
 *
 * The component owns NOTHING semantic about the selection beyond what's
 * in `value` + `onChange` — it's a controlled input. Per-option
 * `disabled` lets callers mirror gates that today live inline (e.g.,
 * TaskDetailModal disabling "done" when canMarkDone gates fail).
 */

export type DropdownOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type Props<T extends string = string> = {
  value: T;
  onChange: (next: T) => void;
  options: DropdownOption<T>[];
  /** Whole-control disabled. */
  disabled?: boolean;
  /** `md` = 44px touch floor (matches Input.module.css .control).
   *  `sm` = chip variant for in-card use. */
  size?: "sm" | "md";
  /** Required: dropdowns must be labelled. */
  ariaLabel: string;
  /** Optional tooltip + native HTML title. */
  title?: string;
  /** Prefix shown in the trigger label, e.g. "View" → "View: To do (3)". */
  triggerPrefix?: string;
  /** Passthrough class on the trigger button. */
  className?: string;
  /** Viewport at or below which the menu becomes a bottom sheet instead of
   *  a popover. Defaults to `"md"` (48rem) — right for sitewide forms and
   *  modals. Task-board consumers pass `"lg"` so the sheet/popover gate
   *  lines up with the board's own kanban-vs-phone CSS gate at `--bp-lg`. */
  sheetBreakpoint?: BreakpointKey;
};

const subscribeClient = () => () => {};
const getClientSnapshot = () => true;
const getClientServerSnapshot = () => false;

export default function Dropdown<T extends string = string>({
  value,
  onChange,
  options,
  disabled,
  size = "md",
  ariaLabel,
  title,
  triggerPrefix,
  className,
  sheetBreakpoint = "md",
}: Props<T>) {
  const reactId = useId();
  const triggerId = `dropdown-trigger-${reactId}`;
  const listboxId = `dropdown-listbox-${reactId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isClient = useSyncExternalStore(
    subscribeClient,
    getClientSnapshot,
    getClientServerSnapshot,
  );

  const sheetSubscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(maxWidth(sheetBreakpoint));
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    [sheetBreakpoint],
  );
  const sheetGetSnapshot = useCallback(
    () => window.matchMedia(maxWidth(sheetBreakpoint)).matches,
    [sheetBreakpoint],
  );
  const isSheet = useSyncExternalStore(
    sheetSubscribe,
    sheetGetSnapshot,
    () => false,
  );

  const [open, setOpen] = useState(false);
  const [activeValue, setActiveValue] = useState<T>(value);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    minWidth: 0,
  });

  // Type-to-jump-by-prefix buffer + last-keystroke timestamp.
  const typeBuffer = useRef("");
  const lastTypeAt = useRef(0);

  const enabledOptions = options.filter((o) => !o.disabled);

  // Reset the keyboard cursor to the currently-selected option whenever
  // the menu transitions to open. Using the render-phase derived-state
  // pattern (cf. TaskDetailModal's `syncedId` reset) rather than an
  // effect; setState-in-effect lints and we don't want a useEffect to
  // run on every render of an open dropdown.
  const [lastSyncedOpen, setLastSyncedOpen] = useState(false);
  if (open !== lastSyncedOpen) {
    setLastSyncedOpen(open);
    if (open) setActiveValue(value);
  }

  // Compute popover position once on open (and on subsequent resizes).
  // Sheet mode skips this entirely (sheet is fixed at bottom).
  useLayoutEffect(() => {
    if (!open || isSheet || !isClient) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipAbove = menuHeight > 0 && spaceBelow < menuHeight && rect.top > spaceBelow;
    setPosition({
      top: flipAbove ? Math.max(8, rect.top - 4 - menuHeight) : rect.bottom + 4,
      left: rect.left,
      minWidth: rect.width,
    });
  }, [open, isSheet, isClient]);

  // Click outside closes.
  // Sheet mode skips this entirely: its own scrim owns the close path
  // (onPointerDown below). On iOS a document-level pointerdown here
  // would fire before the scrim's handler, unmount the scrim, and the
  // synthetic click from touchend would then re-target to whatever
  // trigger sat underneath — opening a second sheet behind the user's
  // back. Belt-and-braces: see scrim onPointerDown + preventDefault.
  useEffect(() => {
    if (!open || isSheet) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, isSheet]);

  // Close popover (not sheet) on scroll / resize — reposition is fiddly
  // and closing is a fine UX trade for now.
  useEffect(() => {
    if (!open || isSheet) return;
    function onClose() {
      setOpen(false);
    }
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [open, isSheet]);

  const moveActive = useCallback(
    (delta: number) => {
      if (enabledOptions.length === 0) return;
      const idx = enabledOptions.findIndex((o) => o.value === activeValue);
      let next = idx + delta;
      if (next < 0) next = enabledOptions.length - 1;
      if (next >= enabledOptions.length) next = 0;
      setActiveValue(enabledOptions[next].value);
    },
    [activeValue, enabledOptions],
  );

  const selectActive = useCallback(() => {
    const target = options.find((o) => o.value === activeValue);
    if (!target || target.disabled) return;
    if (target.value !== value) onChange(target.value);
    setOpen(false);
    // Restore focus to the trigger after selection.
    triggerRef.current?.focus();
  }, [activeValue, onChange, options, value]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (!open) {
        if (
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Enter" ||
          e.key === " "
        ) {
          e.preventDefault();
          setOpen(true);
        }
        return;
      }
      // Menu open.
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        moveActive(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveActive(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        if (enabledOptions.length > 0) setActiveValue(enabledOptions[0].value);
      } else if (e.key === "End") {
        e.preventDefault();
        if (enabledOptions.length > 0) {
          setActiveValue(enabledOptions[enabledOptions.length - 1].value);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectActive();
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Type-to-jump: case-insensitive prefix match against option labels.
        // Native <select> behaviour; resets after 500ms idle.
        const now = Date.now();
        if (now - lastTypeAt.current > 500) typeBuffer.current = "";
        typeBuffer.current += e.key.toLowerCase();
        lastTypeAt.current = now;
        const match = enabledOptions.find((o) =>
          o.label.toLowerCase().startsWith(typeBuffer.current),
        );
        if (match) setActiveValue(match.value);
      }
    },
    [disabled, enabledOptions, moveActive, open, selectActive],
  );

  const current = options.find((o) => o.value === value);
  const triggerLabel = `${triggerPrefix ? `${triggerPrefix}: ` : ""}${current?.label ?? ""}`;

  const triggerClassName = [
    styles.trigger,
    size === "sm" ? styles.triggerSize_sm : styles.triggerSize_md,
    open ? styles.triggerOpen : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  function renderOption(opt: DropdownOption<T>, inSheet: boolean) {
    const optionClass = [
      styles.option,
      inSheet ? styles.sheetOption : "",
      opt.value === value ? styles.optionSelected : "",
      opt.value === activeValue && !opt.disabled ? styles.optionActive : "",
      opt.disabled ? styles.optionDisabled : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div
        key={opt.value}
        id={`${listboxId}-${opt.value}`}
        className={optionClass}
        role="option"
        aria-selected={opt.value === value}
        aria-disabled={opt.disabled || undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (opt.disabled) return;
          if (opt.value !== value) onChange(opt.value);
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onMouseEnter={() => {
          if (!opt.disabled) setActiveValue(opt.value);
        }}
      >
        <span className={styles.optionLabel}>{opt.label}</span>
        {opt.value === value && (
          <span className={styles.optionCheck} aria-hidden>
            ✓
          </span>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={triggerClassName}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-${activeValue}` : undefined}
        onClick={(e) => {
          // Stop bubbling so opening the dropdown doesn't also fire a
          // click on whatever container (e.g. TaskCard) wraps the trigger.
          e.stopPropagation();
          if (!disabled) setOpen((o) => !o);
        }}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.triggerLabel}>{triggerLabel}</span>
        <svg
          className={styles.chevron}
          viewBox="0 0 12 8"
          aria-hidden="true"
        >
          <path
            d="M1 1.5L6 6.5L11 1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isClient &&
        open &&
        createPortal(
          isSheet ? (
            <div className={styles.sheetRoot}>
              <div
                className={styles.scrim}
                onClick={(e) => {
                  // Close on click, not pointerdown. Document-level
                  // pointerdown is already gated off in sheet mode (see
                  // useEffect above), so this is the only close path.
                  // Reacting on click means the scrim stays mounted
                  // through pointerdown → pointerup → click — iOS hit-
                  // tests the synthetic click against the scrim (still
                  // mounted) and fires THIS handler, instead of
                  // re-targeting to the trigger underneath.
                  e.stopPropagation();
                  setOpen(false);
                }}
              />
              <div
                ref={menuRef}
                id={listboxId}
                className={styles.sheet}
                role="listbox"
                aria-labelledby={triggerId}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={styles.sheetHandle} aria-hidden />
                {options.map((opt) => renderOption(opt, true))}
                <button
                  type="button"
                  className={styles.sheetCancel}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div
              ref={menuRef}
              id={listboxId}
              className={styles.popover}
              role="listbox"
              aria-labelledby={triggerId}
              style={{
                top: `${position.top}px`,
                left: `${position.left}px`,
                minWidth: `${position.minWidth}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {options.map((opt) => renderOption(opt, false))}
            </div>
          ),
          document.body,
        )}
    </>
  );
}
