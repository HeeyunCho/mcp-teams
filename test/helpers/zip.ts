// Reads a .zip file's entries (stored or deflated), for checking what a store upload holds (#216).
// Only what scripts/package-extension.mjs writes: no ZIP64, no encryption, no data descriptors.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export function readZip(file: string): Map<string, Buffer> {
  const buf = readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file: no end of central directory");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(at + 10);
    const packedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + packedSize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported compression ${method} for ${name}`);
    if (data.length !== size) throw new Error(`${name}: ${data.length} bytes, the directory says ${size}`);
    entries.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
