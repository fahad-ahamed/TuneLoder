/**
 * Streaming ZIP writer — hand-rolled, zero dependencies.
 *
 * Why not archiver/zlib: ZIP delivery has to START streaming immediately
 * (long playlists download track-by-track while the browser already shows
 * "saving"), and `zlib.crc32` doesn't exist on older Node runtimes.
 *
 * Format (STORE method, no compression — MP3s are already compressed):
 *   local file header   0x04034b50
 *   central directory   0x02014b50
 *   end-of-central-dir  0x06054b50
 *   general purpose bit 11 (0x0800) = UTF-8 filenames (Bangla titles!)
 */

import fs from "fs";
import { Readable } from "stream";

/* ---------------- CRC-32 (table-based, standard poly 0xEDB88320) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32Update(crc: number, buf: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------- writer ---------------- */

type Entry = { name: string; size: number; crc: number; offset: number };

export class ZipStreamWriter {
  private entries: Entry[] = [];
  private offset = 0;
  private closed = false;
  private readonly write: (chunk: Uint8Array) => Promise<void> | void;

  constructor(write: (chunk: Uint8Array) => Promise<void> | void) {
    this.write = write;
  }

  /** ZIP stores byte offsets/lengths — JS .length counts UTF-16 units, not bytes */
  private byteLen(s: string): number {
    return Buffer.byteLength(s, "utf8");
  }

  /** add a file from disk — streams it through in 64 KB chunks (STORE) */
  async addFile(name: string, filePath: string): Promise<void> {
    if (this.closed) throw new Error("zip already finalized");
    const clean = sanitizeZipName(name);
    const st = fs.statSync(filePath);
    const size = st.size;

    // local file header
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    header.writeUInt16LE(0, 8); // method: STORE
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0x21, 12); // mod date (1980-01-01, deterministic)
    header.writeUInt32LE(0, 14); // crc (filled after streaming — we know it first though)
    header.writeUInt32LE(size, 18); // compressed size (= size for STORE)
    header.writeUInt32LE(size, 22); // uncompressed size
    header.writeUInt16LE(clean.length, 26);
    header.writeUInt16LE(0, 28); // extra len

    // we need CRC BEFORE writing the header (STORE allows streaming without a
    // data descriptor only when sizes+crc are upfront) → one extra read pass
    let crc = 0;
    const crcStream = fs.createReadStream(filePath, { highWaterMark: 1 << 16 });
    for await (const chunk of crcStream) crc = crc32Update(crc, chunk as Buffer);
    header.writeUInt32LE(crc >>> 0, 14);

    const nameBytes = this.byteLen(clean);
    header.writeUInt16LE(nameBytes, 26);

    await this.write(header);
    await this.write(Buffer.from(clean, "utf8"));
    const offset = this.offset;
    this.offset += header.length + nameBytes;

    // content
    const content = fs.createReadStream(filePath, { highWaterMark: 1 << 16 });
    for await (const chunk of content) {
      const buf = chunk as Buffer;
      await this.write(buf);
      this.offset += buf.length;
    }

    this.entries.push({ name: clean, size, crc: crc >>> 0, offset });
  }

  /** add an in-memory string as a file (used for _FAILED.txt) */
  async addText(name: string, text: string): Promise<void> {
    const clean = sanitizeZipName(name);
    const data = Buffer.from(text, "utf8");
    const crc = crc32Update(0, data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    const nameBytes = this.byteLen(clean);
    header.writeUInt16LE(nameBytes, 26);
    header.writeUInt16LE(0, 28);

    await this.write(header);
    await this.write(Buffer.from(clean, "utf8"));
    await this.write(data);
    this.entries.push({ name: clean, size: data.length, crc, offset: this.offset });
    this.offset += header.length + nameBytes + data.length;
  }

  /** central directory + EOCD — call once at the very end */
  async finalize(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const central: Buffer[] = [];
    let centralSize = 0;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(0x0800, 8); // UTF-8 flag
      h.writeUInt16LE(0, 10); // STORE
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0x21, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      const nameBytes = this.byteLen(e.name);
      h.writeUInt16LE(nameBytes, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(0, 38); // external attrs
      h.writeUInt32LE(e.offset, 42);
      central.push(h, Buffer.from(e.name, "utf8"));
      centralSize += 46 + nameBytes;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); // disk
    eocd.writeUInt16LE(0, 6); // cd disk
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(this.offset, 16); // cd offset
    eocd.writeUInt16LE(0, 20);

    for (const b of central) await this.write(b);
    await this.write(eocd);
  }

  get fileCount(): number {
    return this.entries.length;
  }
}

/** unique, ZIP-safe, ≤120 chars — "01 - Title [128kbps].mp3" style names are built by the caller */
export function sanitizeZipName(name: string): string {
  const clean = name
    .normalize("NFKD")
    // keep \p{M} so Bangla vowel signs (কার) survive, like the route safeName();
    // []_ stay so "[128kbps]" suffixes and "_FAILED.txt" keep their shape
    .replace(/[^\p{L}\p{N}\p{M} ()\-'.,&\[\]_]/gu, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return clean || "file";
}

/** ReadableStream from a ZipStreamWriter — the download-zip route's body */
export function zipStream(
  build: (zip: ZipStreamWriter) => Promise<void>,
  onAbort?: () => void,
  signal?: { abort: () => void } // AbortController signal (structural — avoids lib conflicts)
): ReadableStream<Uint8Array> {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      const zip = new ZipStreamWriter((chunk) => {
        controller.enqueue(
          chunk instanceof Uint8Array ? chunk : new Uint8Array(Buffer.from(chunk))
        );
      });
      try {
        await build(zip);
        await zip.finalize();
        controller.close();
      } catch (e) {
        onAbort?.();
        try {
          controller.error(e);
        } catch {
          /* already errored/aborted */
        }
      }
    },
    cancel() {
      onAbort?.();
      signal?.abort();
    },
  });
  void controllerRef;
  return stream;
}
