/* Test the exact convertToMp3 pipeline used by /api/download:
   URL input → ffmpeg → tagged MP3 → file, then verify with ffprobe. */
const { convertToMp3, cleanupTemp } = require("/home/z/my-project/src/lib/ytd/providers.ts");

async function main() {
  const out = await convertToMp3(
    { kind: "url", url: "http://localhost:8099/testsrc.mp3" },
    { bitrate: 320, title: "Parinda (Official Lyrical Video) | Giraah", author: "Giraah" }
  );
  const fs = require("fs");
  const size = fs.statSync(out).size;
  console.log("CONVERT OK:", out, size, "bytes");

  // verify with ffprobe
  const { execFileSync } = require("child_process");
  const probe = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration,bit_rate:format_tags=title,artist",
    "-of", "json", out,
  ]).toString();
  console.log("PROBE:", probe);

  // test ID3 tags present
  const tags = JSON.parse(probe).format.tags;
  console.log("TAGS:", tags ? `${tags.title} — ${tags.artist}` : "NO TAGS (bad)");

  cleanupTemp(out);
  console.log("CLEANUP OK");
}

main().catch((e) => {
  console.error("TEST FAILED:", e.message);
  process.exit(1);
});
