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
};

export default nextConfig;
