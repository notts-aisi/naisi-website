"use client";

import { useSyncExternalStore, useState } from "react";
import { useIsStandalone } from "@/hooks/useDisplayMode";
import { getInstallPlatform } from "@/lib/pwa/displayMode";
import {
  hasDeferredPrompt,
  subscribeInstallPrompt,
  triggerInstall,
} from "./installPrompt";
import styles from "./InstallLink.module.css";

/**
 * The permanent, quiet install route: one row in AppShell's mobile drawer.
 * Never times, never nags, cannot be orphaned by a dismissal, and lives
 * where someone who has heard "you can install this" would go looking.
 *
 * Android with Chrome's deferred prompt captured: a real install button.
 * iOS: the one-line instruction, since Safari has no prompt API and
 * Share then Add to Home Screen is the only route in.
 * Installed already, or desktop: renders nothing.
 *
 * Safe to gate on the hook here (unlike the auth card reorder): the drawer
 * only exists after a user gesture, long past hydration, so the
 * first-render false can never flash.
 */
export function InstallLink() {
  const isStandalone = useIsStandalone();
  const promptReady = useSyncExternalStore(
    subscribeInstallPrompt,
    hasDeferredPrompt,
    () => false,
  );
  const [platform] = useState(() =>
    typeof window === "undefined" ? null : getInstallPlatform(),
  );

  if (isStandalone || platform === null || platform === "desktop") return null;

  if (platform === "android") {
    if (!promptReady) return null;
    return (
      <div className={styles.row}>
        <button
          type="button"
          className={styles.installButton}
          onClick={() => void triggerInstall()}
        >
          Install the app
        </button>
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <p className={styles.iosHint}>
        Get the app: tap <strong>Share</strong> in Safari, then{" "}
        <strong>Add to Home Screen</strong>.
      </p>
    </div>
  );
}
