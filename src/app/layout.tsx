import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { AuthProvider } from "@/auth/AuthProvider";
import "./globals.css";

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
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="dark" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
