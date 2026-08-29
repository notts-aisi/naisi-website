"use client";

import { useState, useSyncExternalStore } from "react";
import Button from "@/components/ui/Button";
import { useIsStandalone } from "@/hooks/useDisplayMode";
import { getInstallPlatform } from "@/lib/pwa/displayMode";
import {
  dismissInstallCard,
  hasDeferredPrompt,
  installCardDismissed,
  subscribeInstallPrompt,
  triggerInstall,
} from "./installPrompt";
import styles from "./InstallCard.module.css";

/**
 * The quiet install invitation: one dismissible card on the dashboard, for
 * signed-in members on phones. Committee and members are who benefit from
 * the app; a public visitor reading a news post is deliberately never
 * shown anything.
 *
 * Renders null when: already installed (standalone), previously dismissed,
 * on desktop, or during SSR and first paint (useIsStandalone is false then,
 * but the phone check also needs the client, so the whole card is
 * client-gated; a flash of the card for installed users is prevented by the
 * standalone check happening in the same render that first shows it).
 *
 * Android taps straight into Chrome's install dialog when the browser has
 * offered one; iOS gets the two-step instruction, since Safari has no
 * prompt API and Share then Add to Home Screen is the only route.
 */
export function InstallCard() {
  const isStandalone = useIsStandalone();
  const promptReady = useSyncExternalStore(
    subscribeInstallPrompt,
    hasDeferredPrompt,
    () => false,
  );
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [platform, setPlatform] = useState<"ios" | "android" | "desktop" | null>(null);

  // Client-only facts, resolved once. Lazy state init runs during the first
  // client render, which is what keeps the card out of the server HTML.
  if (dismissed === null && typeof window !== "undefined") {
    setDismissed(installCardDismissed());
    setPlatform(getInstallPlatform());
  }

  if (dismissed !== false || isStandalone || platform === "desktop" || platform === null) {
    return null;
  }

  const close = () => {
    dismissInstallCard();
    setDismissed(true);
  };

  return (
    <div className={styles.card}>
      <div className={styles.copy}>
        <p className={styles.title}>Add NAISI to your home screen</p>
        <p className={styles.detail}>
          {platform === "ios"
            ? "Tap Share in Safari, then Add to Home Screen. The site becomes an app: full screen, its own icon, straight to your work."
            : "Install the app for full screen, an icon on your home screen, and faster access to your work."}
        </p>
      </div>
      <div className={styles.actions}>
        {platform === "android" && promptReady && (
          <Button
            size="sm"
            onClick={() => {
              void triggerInstall().then((accepted) => {
                if (accepted) close();
              });
            }}
          >
            Install
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={close}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
