import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root to this project. Without this, Turbopack
  // auto-detects based on nearby package-lock.json files and can pick up
  // `../package-lock.json` from the parent Projects/ folder, which breaks
  // the React Client Manifest ("Could not find the module global-error.js").
  turbopack: {
    root: path.resolve(__dirname),
  },
  async redirects() {
    return [
      // Instagram bio link points at /stay-in-touch. Instagram appends its
      // own ?utm_source=ig&fbclid=... params, so the bare path 404s and the
      // real target (the #stay-in-touch section on the homepage) is
      // unreachable without this redirect. Query params forward by default,
      // and the # fragment is preserved by the browser following the redirect.
      {
        source: "/stay-in-touch",
        destination: "/#stay-in-touch",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
