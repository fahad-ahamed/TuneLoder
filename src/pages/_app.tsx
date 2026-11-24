import type { AppProps } from "next/app";
import "@/app/globals.css";
import { Toaster } from "@/components/ui/sonner";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <Toaster theme="system" position="bottom-right" richColors />
    </>
  );
}
