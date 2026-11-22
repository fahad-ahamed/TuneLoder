import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Dark/light toggle. The initial state is whatever the pre-paint script in
 * _document.tsx decided (localStorage "tl-theme", else OS preference) — we
 * only READ the class here, never guess, so there is no hydration flash.
 */
export default function ThemeToggle({ className = "" }: { className?: string }) {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const el = document.documentElement;
    setDark(el.classList.contains("dark"));
    // follow the OS if the user never picked explicitly
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      let stored: string | null = null;
      try { stored = localStorage.getItem("tl-theme"); } catch { /* noop */ }
      if (stored) return;
      el.classList.toggle("dark", e.matches);
      el.style.colorScheme = e.matches ? "dark" : "light";
      setDark(e.matches);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = () => {
    const next = !(dark ?? document.documentElement.classList.contains("dark"));
    const el = document.documentElement;
    el.classList.toggle("dark", next);
    el.style.colorScheme = next ? "dark" : "light";
    try { localStorage.setItem("tl-theme", next ? "dark" : "light"); } catch { /* noop */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next ? "#09090b" : "#ffffff");
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/60 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${className}`}
    >
      {dark === null ? (
        <span className="h-[1.05rem] w-[1.05rem]" />
      ) : dark ? (
        <Sun className="h-[1.05rem] w-[1.05rem]" />
      ) : (
        <Moon className="h-[1.05rem] w-[1.05rem]" />
      )}
    </button>
  );
}
