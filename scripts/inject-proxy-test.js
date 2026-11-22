#!/usr/bin/env node
/**
 * Faithful local reproduction of BasicDeploy's proxy HTML tampering:
 *   1. og/twitter meta block inserted right after <head>
 *   2. banner <style>+<div> inserted after <title> INSIDE head (browser parser
 *      relocates this div into body as its FIRST child — the hydration breaker)
 *   3. the same banner appended right before </body>
 * Verified byte-for-byte against the real proxy output.
 */
const http = require("http");

const META = `<meta property="og:site_name" content="BasicDeploy"><meta property="og:type" content="website"><meta property="og:url" content="https://w33qy6jj.basicdeploy.com"><meta property="og:title" content="w33qy6jj"><meta property="og:description" content="Running on BasicDeploy - the persistent runtime your agent deploys to."><meta property="og:image" content="https://basicdeploy.com/og-image.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="w33qy6jj"><meta name="twitter:description" content="Running on BasicDeploy - the persistent runtime your agent deploys to."><meta name="twitter:image" content="https://basicdeploy.com/og-image.png"><meta name="generator" content="BasicDeploy">`;

const BANNER = `<style>body{padding-bottom:2.6em}</style><div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;margin:0;font:12px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:rgba(17,17,27,.9);color:#cdd6f4;text-align:center;padding:6px 12px;box-shadow:0 -1px 6px rgba(0,0,0,.3)">This app is user-hosted on <a href="https://basicdeploy.com" target="_blank" rel="noopener" style="color:#89b4fa;text-decoration:underline">BasicDeploy</a> and is not reviewed or endorsed. <a href="https://basicdeploy.com/report?host=w33qy6jj.basicdeploy.com" target="_blank" rel="noopener" style="color:#89b4fa;text-decoration:underline">Report abuse</a></div>`;

const UPSTREAM = parseInt(process.env.UPSTREAM || "3101", 10);
const PORT = parseInt(process.env.LISTEN || "3102", 10);

http
  .createServer((req, res) => {
    const url = `http://127.0.0.1:${UPSTREAM}${req.url}`;
    fetch(url, { headers: { "user-agent": req.headers["user-agent"] || "curl" } })
      .then(async (up) => {
        const headers = Object.fromEntries(
          [...up.headers.entries()].filter(([k]) => !["content-encoding", "transfer-encoding", "content-length"].includes(k))
        );
        const ct = up.headers.get("content-type") || "";
        if (!/text\/html/.test(ct)) {
          const buf = Buffer.from(await up.arrayBuffer());
          res.writeHead(up.status, headers);
          res.end(buf);
          return;
        }
        let html = await up.text();
        html = html.replace(/(<html[^>]*>\s*<head>)/i, `$1${META}`);
        html = html.replace(/(<title>[^<]*<\/title>)/i, `$1${BANNER}`);
        html = html.replace(/(<\/body>)/i, `${BANNER}$1`);
        res.writeHead(up.status, headers);
        res.end(html);
      })
      .catch((e) => {
        res.writeHead(502);
        res.end("proxy error: " + e.message);
      });
  })
  .listen(PORT, "127.0.0.1", () => console.log(`inject-proxy on :${PORT} → :${UPSTREAM} (metas + head banner + end banner)`));
