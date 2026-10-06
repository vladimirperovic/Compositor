// Stored ZIP32, per PKWARE APPNOTE 4.3. Images are already compressed by their encoder.
// Blob parts keep the archive from needing another full-size Uint8Array in memory.
const MAX = 0xffffffff;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function checkCancelled(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

async function crc32(blob, signal) {
  let crc = MAX;
  // Bounded reads also give Cancel a chance between chunks of a large image.
  for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
    checkCancelled(signal);
    const bytes = new Uint8Array(await blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
    for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  }
  checkCancelled(signal);
  return (crc ^ MAX) >>> 0;
}

export class ImageZip {
  constructor() {
    this.parts = [];
    this.directory = [];
    this.offset = 0;
    this.directorySize = 0;
  }

  async add(name, blob, signal) {
    const filename = encoder.encode(name);
    const nextOffset = this.offset + 30 + filename.length + blob.size;
    const nextDirectory = this.directorySize + 46 + filename.length;
    if (!filename.length || filename.length > 65535 || this.directory.length >= 65534
        || blob.size >= MAX || nextOffset + nextDirectory + 22 >= MAX) {
      throw new Error('This batch is too large for one ZIP. Select fewer images and try again.');
    }
    const crc = await crc32(blob, signal);
    const now = new Date();
    const year = Math.min(2107, Math.max(1980, now.getFullYear()));
    const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const local = new Uint8Array(30 + filename.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 filenames, storage method 0.
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, blob.size, true);
    header.setUint32(22, blob.size, true);
    header.setUint16(26, filename.length, true);
    local.set(filename, 30);

    const central = new Uint8Array(46 + filename.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    central.set(local.subarray(4, 30), 6);
    record.setUint32(42, this.offset, true);
    central.set(filename, 46);
    this.parts.push(local, blob);
    this.directory.push(central);
    this.offset = nextOffset;
    this.directorySize = nextDirectory;
  }

  finish() {
    const end = new Uint8Array(22);
    const record = new DataView(end.buffer);
    record.setUint32(0, 0x06054b50, true);
    record.setUint16(8, this.directory.length, true);
    record.setUint16(10, this.directory.length, true);
    record.setUint32(12, this.directorySize, true);
    record.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.directory, end], { type: 'application/zip' });
  }
}
