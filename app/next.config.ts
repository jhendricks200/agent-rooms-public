import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dark circular "N" badge seen floating bottom-left over the
  // composer and the proposal detail page is Next.js's own dev-mode
  // route indicator (see devIndicators.md in node_modules/next/dist/docs),
  // not an app element - it never ships in a production build. It still
  // reads as a design bug in local review, so it is turned off here rather
  // than left to overlap content during every jam rehearsal.
  devIndicators: false,
};

export default nextConfig;
