import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { AuthProvider } from "@/auth/AuthProvider";
import { SiteNoticeBanner } from "@/features/maintenance/SiteNoticeBanner";
import { ServiceWorkerRegistrar } from "@/features/pwa/ServiceWorkerRegistrar";
import { StandaloneFlag } from "@/features/pwa/StandaloneFlag";
import { PAGE_FLOOR } from "@/theme/brandColors";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /*
   * Tints Chrome on Android's address bar in a normal tab, and the status bar
   * of the installed app. Matches the manifest's theme_color and
   * background_color so the status bar and the Android splash screen form one
   * flat field.
   *
   * A single flat value, with no prefers-color-scheme variants, because
   * data-theme="dark" is a hardcoded literal on <html> below and the
   * [data-theme="light"] block in tokens.css is currently unreachable.
   *
   * Set once at the root and inherited everywhere. Next's mergeViewport
   * overrides per key and only for keys physically present on a child's
   * viewport export, so (auth)/layout.tsx's override does not clear this (or
   * viewportFit). Do not add per-route themeColor values: one that differs
   * between routes flashes the Android status bar on every navigation.
   */
  themeColor: PAGE_FLOOR,
};

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://naisi.uk"),
  title: {
    default: "Nottingham AI Safety Initiative",
    template: "%s · NAISI",
  },
  description:
    "The AI safety student community at the University of Nottingham. Termly courses, real projects, and a weekly digest of what's happening in the field.",
  openGraph: {
    title: "Nottingham AI Safety Initiative",
    description:
      "A student community at the University of Nottingham focused on AI safety.",
    siteName: "NAISI",
    type: "website",
  },
  twitter: { card: "summary_large_image" },
  /*
   * Names the iOS home-screen icon. Next emits <meta name="mobile-web-app-capable">
   * and <meta name="apple-mobile-web-app-title"> for this, and ALWAYS emits
   * apple-mobile-web-app-status-bar-style, because resolveAppleWebApp defaults
   * it to "default" and there is no way to suppress the tag.
   *
   * "default" is the value we want. iOS draws its own opaque status bar above
   * the page, so nothing renders underneath it and no top-edge audit is needed.
   * Going full-bleed would mean "black-translucent", which additionally
   * requires the legacy apple-mobile-web-app-capable meta that Next cannot
   * emit, and would put every sticky header under the clock. Written out
   * explicitly rather than left to the default so nobody reads the omission as
   * "we did not think about the status bar".
   *
   * Deliberately no metadata.manifest and no metadata.icons here: static
   * discovery of manifest.ts and of icon.png / apple-icon.png already emits
   * both, and mergeStaticMetadata runs last so an explicit value would lose.
   */
  appleWebApp: {
    title: "NAISI",
    statusBarStyle: "default",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body>
        {/* Must be the first thing in <body>: it stamps the standalone
            attributes on <html> before any styled content paints. */}
        <StandaloneFlag />
        <AuthProvider>
          <SiteNoticeBanner />
          {children}
        </AuthProvider>
        {/* After the app content: registration is not urgent and must never
            delay first paint. Renders nothing. */}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
