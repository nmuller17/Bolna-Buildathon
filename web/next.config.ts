import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // public/signs links to the repo's signs/ folder: let Turbopack resolve files up to the repo root.
  turbopack: { root: path.join(__dirname, "..") },
};

export default nextConfig;
