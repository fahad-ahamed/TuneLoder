import { Head, Html, Main, NextScript } from "next/document";
/**
 * Pages Router shell — React hydrates ONLY the <div id="__next"> Main node,
 * so proxy-injected foreign nodes in <head>/<body> (hosting platform branding
 * banner) can never break hydration. The <head> below is plain static HTML.
 */
export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <title>TuneLoad — YouTube to MP3</title>
        <meta name="description" content="Fast, clean YouTube to MP3 converter with full playlist support, all qualities up to 320kbps, and a premium no-ads experience." />
        <meta name="keywords" content="YouTube to MP3, MP3 downloader, playlist download, 320kbps, audio converter" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta property="og:title" content="TuneLoad — YouTube to MP3" />
        <meta property="og:description" content="Fast, clean YouTube to MP3 converter with full playlist support and all qualities up to 320kbps." />
        <meta property="og:type" content="website" />
        <meta name="theme-color" content="#09090b" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body className="antialiased bg-background text-foreground" style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
