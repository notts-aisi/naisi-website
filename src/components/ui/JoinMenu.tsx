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
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { maxWidth } from "@/theme/breakpoints";
import dd from "./Dropdown.module.css";
import styles from "./JoinMenu.module.css";

/**
 * The "Join us" chooser. Reuses the proven Dropdown shell (portalled popover
 * ≥ --bp-md, slide-up bottom sheet below it, scrim + safe-area + reduced-motion)
 * but renders a two-section NAV menu rather than a single-select control: the
 * University of Nottingham path on top, and a visually separated, differently-
 * coloured external-collaborator path below. Selecting routes; nothing persists.
 *
 * Trigger styling comes entirely from `className` so it matches its context
 * (the header join button, the hero CTA, …). Only the menu panel adopts the
 * dropdown look.
 */

type JoinOption = {
  key: string;
  label: string;
  sub?: string;
  href: string;
  tone?: "default" | "collaborator";
};

const OPTIONS: JoinOption[] = [
  {
    key: "uni",
    label: "University of Nottingham member",
    sub: "Students & staff — apply to join the society",
    href: "/register",
  },
  {
    key: "collaborator",
    label: "Collaborate with us",
    sub: "Not at Nottingham? Pitch a project as an external collaborator",
    href: "/register?type=collaborator",
    tone: "collaborator",
  },
];

const subscribeClient = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export default function JoinMenu({
  className,
  label = "Join us",
}: {
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  const reactId = useId();
  const triggerId = `join-trigger-${reactId}`;
  const menuId = `join-menu-${reactId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isClient = useSyncExternalStore(
    subscribeClient,
    getClientSnapshot,
    getServerSnapshot,
  );

  const sheetSubscribe = useCallback((cb: () => void) => {
    const mq = window.matchMedia(maxWidth("md"));
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const sheetGetSnapshot = useCallback(
    () => window.matchMedia(maxWidth("md")).matches,
    [],
  );
  const isSheet = useSyncExternalStore(sheetSubscribe, sheetGetSnapshot, () => false);

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, minWidth: 0 });

  // Popover position (sheet is fixed at the bottom, so skip it there).
  useLayoutEffect(() => {
    if (!open || isSheet || !isClient) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipAbove =
      menuHeight > 0 && spaceBelow < menuHeight && rect.top > spaceBelow;
    setPosition({
      top: flipAbove ? Math.max(8, rect.top - 4 - menuHeight) : rect.bottom + 4,
      left: rect.left,
      minWidth: rect.width,
    });
  }, [open, isSheet, isClient]);

  // Click-outside closes the popover (the sheet's scrim owns its own close).
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

  // Close the popover on scroll / resize (reposition is fiddly).
  useEffect(() => {
    if (!open || isSheet) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, isSheet]);

  const choose = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  const onTriggerKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        setOpen(true);
      } else if (open && e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
    [open],
  );

  function renderOptions(inSheet: boolean) {
    return OPTIONS.map((opt) => {
      const collaborator = opt.tone === "collaborator";
      const rowClass = [
        styles.optionRow,
        inSheet ? styles.sheetRow : "",
        collaborator ? styles.collaborator : "",
      ]
        .filter(Boolean)
        .join(" ");
      return (
        <div key={opt.key}>
          {collaborator && (
            <div
              className={[styles.divider, inSheet ? styles.sheetDivider : ""]
                .filter(Boolean)
                .join(" ")}
              aria-hidden
            />
          )}
          <button
            type="button"
            role="menuitem"
            className={rowClass}
            onClick={(e) => {
              e.stopPropagation();
              choose(opt.href);
            }}
          >
            <span className={styles.optionLabel}>{opt.label}</span>
            {opt.sub && <span className={styles.optionSub}>{opt.sub}</span>}
          </button>
        </div>
      );
    });
  }

  return (
    <>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {label}
      </button>

      {isClient &&
        open &&
        createPortal(
          isSheet ? (
            <div className={dd.sheetRoot}>
              <div
                className={dd.scrim}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                }}
              />
              <div
                ref={menuRef}
                id={menuId}
                className={dd.sheet}
                role="menu"
                aria-labelledby={triggerId}
                onClick={(e) => e.stopPropagation()}
              >
                <div className={dd.sheetHandle} aria-hidden />
                <div className={styles.sheetHeading}>How would you like to join?</div>
                {renderOptions(true)}
                <button
                  type="button"
                  className={dd.sheetCancel}
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
              id={menuId}
              className={[dd.popover, styles.popover].join(" ")}
              role="menu"
              aria-labelledby={triggerId}
              style={{
                top: `${position.top}px`,
                left: `${position.left}px`,
                minWidth: `${Math.max(position.minWidth, 260)}px`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {renderOptions(false)}
            </div>
          ),
          document.body,
        )}
    </>
  );
}
