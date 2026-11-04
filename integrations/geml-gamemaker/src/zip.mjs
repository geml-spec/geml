// A zip archive, written and read back with nothing but Node's zlib: the
// release a build hands out, and the copy of it the build's self-test unpacks.
//
// Every entry carries the same timestamp (1980-01-01, the format's epoch), so
// the same files make the same bytes and the same sha256 — a release can be
// rebuilt and compared. Entries are deflated, names are UTF-8 (flag bit 11),
// and a POSIX mode rides in the external attributes so an exported Linux
// binary unpacks executable. Zip64 is not written: a game past 4 GB is refused
// rather than archived wrong.

import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MADE_BY_UNIX = (3 << 8) | 20;
const LIMIT = 0xfffffffe;

/** `entries`: `{ name, data, mode? }`, `name` with `/` separators. */
export function writeZip(entries) {
  if (entries.length > 0xffff) throw new Error(`a zip holds at most 65535 entries, not ${entries.length}`);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mode = 0o644 } of entries) {
    const bytes = Buffer.from(data);
    const packed = deflateRawSync(bytes, { level: 9 });
    if (bytes.length > LIMIT || packed.length > LIMIT || offset > LIMIT) throw new Error(`${name}: past 4 GB, which this writer does not archive`);
    const file = Buffer.from(name, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(file.length, 26);
    local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(CENTRAL, 0);
    head.writeUInt16LE(MADE_BY_UNIX, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(UTF8, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(bytes.length, 24);
    head.writeUInt16LE(file.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    parts.push(local, file, packed);
    central.push(head, file);
    offset += local.length + file.length + packed.length;
  }
  const directory = Buffer.concat(central);
  if (offset > LIMIT) throw new Error("the archive is past 4 GB, which this writer does not archive");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Every entry of `zip` as `{ name, data, mode }`; a damaged entry throws. */
export function readZip(zip) {
  let at = zip.length - 22;
  while (at >= 0 && zip.readUInt32LE(at) !== END) at--;
  if (at < 0) throw new Error("not a zip archive: no end of central directory");
  const count = zip.readUInt16LE(at + 10);
  let p = zip.readUInt32LE(at + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error(`entry ${i + 1}: no central directory header`);
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const packedSize = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extra = zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
    const attrs = zip.readUInt32LE(p + 38);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extra;
    if (zip.readUInt32LE(local) !== LOCAL) throw new Error(`${name}: no local header`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(start, start + packedSize);
    const data = method === 8 ? inflateRawSync(packed) : method === 0 ? Buffer.from(packed) : null;
    if (data === null) throw new Error(`${name}: compression method ${method} is not read here`);
    if (crc32(data) !== crc) throw new Error(`${name}: the data does not match its checksum`);
    out.push({ name, data, mode: (attrs >>> 16) & 0o777 });
  }
  return out;
}
