"use client";

import { useEffect, useState } from "react";

/**
 * Client-only rendering gate.
 *
 * The hosting proxy injects a branding banner <div> INSIDE <head>; the browser
 * HTML parser relocates that div into <body> as its FIRST child, which makes
 * React hydration compare a DOM tree that differs from the server HTML
 * (React error #418). Rendering the app only after mount sidesteps the
 * comparison entirely — SSR still emits <head> metadata (title, og, styles,
 * scripts), while the interactive UI mounts cleanly on the client.
 */
export function NoSSR({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : null;
}
