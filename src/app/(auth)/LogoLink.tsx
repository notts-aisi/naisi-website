"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import logoStyles from "./LogoLink.module.css";

/** Custom event the auth pages listen for to play a back-swipe animation
 *  before the layout navigates to "/". Cancelable: the page calls
 *  preventDefault() to indicate it'll handle the navigation itself, so
 *  LogoLink shouldn't fire its own router.push. */
export const AUTH_BACK_HOME_EVENT = "naisi:auth-back-home";

/** Dispatched by login / register pages once GIS is ready and the card
 *  is about to swipe in. LogoLink listens for it so the NAISI logo can
 *  float in from the left in sync with the card arriving from the right. */
export const AUTH_PAGE_READY_EVENT = "naisi:auth-page-ready";

type Props = {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
};

/**
 * Logo link for the auth layout. On left-click without modifiers we
 * dispatch a cancelable custom event so the underlying auth page (login
 * / register / pending-approval) can intercept it and animate its own
 * exit before the route actually changes. If nothing intercepts, falls
 * back to a regular router.push.
 *
 * Modifier-clicks (cmd/ctrl/shift/middle) are left alone for native
 * open-in-new-tab behavior.
 */
export default function LogoLink({ children, className, ...rest }: Props) {
  const router = useRouter();
  const [entered, setEntered] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const onReady = () => setEntered(true);
    window.addEventListener(AUTH_PAGE_READY_EVENT, onReady);
    // Safety fallback in case GIS never reports — reveal the logo after
    // 2.4s regardless so the corner doesn't sit empty forever.
    const t = setTimeout(() => setEntered(true), 2400);
    return () => {
      window.removeEventListener(AUTH_PAGE_READY_EVENT, onReady);
      clearTimeout(t);
    };
  }, []);

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const evt = new CustomEvent(AUTH_BACK_HOME_EVENT, { cancelable: true });
    window.dispatchEvent(evt);
    if (!evt.defaultPrevented) {
      router.push("/");
    } else {
      // Page intercepted — float the logo back out to the left in sync
      // with the card swiping back out to the right.
      setExiting(true);
    }
  };

  const entryClass = exiting
    ? logoStyles.logoExiting
    : entered
      ? logoStyles.logoEntered
      : logoStyles.logoEntering;

  const composedClass = [className, entryClass].filter(Boolean).join(" ");

  return (
    <Link href="/" className={composedClass} onClick={handleClick} {...rest}>
      {children}
    </Link>
  );
}
