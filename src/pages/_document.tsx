import { Head, Html, Main, NextScript } from "next/document";
/**
 * Pages Router shell — React hydrates ONLY the <div id="__next"> Main node,
 * so proxy-injected foreign nodes in <head>/<body> (hosting platform branding
 * banner) can never break hydration. The <head> below is plain static HTML.
 *
 * Dark/light theming: the user's explicit choice lives in localStorage
 * ("tl-theme": "dark" | "light"); with no choice the OS preference wins.
 * The inline script below runs BEFORE first paint (no flash), applies the
 * .dark class on <html> (Tailwind @custom-variant) and syncs the theme-color
 * meta so the mobile browser chrome matches.
 */
const themeInit = `(function(){try{
var t=null;try{t=localStorage.getItem("tl-theme");}catch(e){}
var dark=t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches;
var el=document.documentElement;
el.classList.toggle("dark",dark);
el.style.colorScheme=dark?"dark":"light";
var m=document.querySelector('meta[name="theme-color"]');
if(m)m.setAttribute("content",dark?"#09090b":"#ffffff");
}catch(e){}})();`;

export default function Document() {
  return (
    <Html lang="en" suppressHydrationWarning>
      <Head>
        <title>TuneLoad — YouTube to MP3</title>
        <meta name="description" content="Fast, clean YouTube to MP3 converter with full playlist support, all qualities up to 320kbps, and a premium no-ads experience." />
        <meta name="keywords" content="YouTube to MP3, MP3 downloader, playlist download, 320kbps, audio converter" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta property="og:title" content="TuneLoad — YouTube to MP3" />
        <meta property="og:description" content="Fast, clean YouTube to MP3 converter with full playlist support and all qualities up to 320kbps." />
        <meta property="og:type" content="website" />
        <meta name="theme-color" content="#09090b" />
        {/* PWA / add-to-home-screen — real brand icons + short app title.
            iOS takes the home-screen NAME from apple-mobile-web-app-title
            (falls back to <title>, which truncates) and the ICON from
            apple-touch-icon (falls back to a letter tile without it). */}
        {/* ?v= cache-bust: iOS keys home-screen icons by URL and keeps showing
            the stale letter tile until the URL itself changes. */}
        <link rel="manifest" href="/manifest.json?v=2" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" href="/icons/favicon-32.png?v=2" sizes="32x32" />
        <link rel="icon" type="image/png" href="/icons/favicon-16.png?v=2" sizes="16x16" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png?v=2" />
        <link rel="apple-touch-icon-precomposed" sizes="180x180" href="/apple-touch-icon-precomposed.png?v=2" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="TuneLoad" />
        <meta property="og:image" content="/icons/icon-512.png" />
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
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
