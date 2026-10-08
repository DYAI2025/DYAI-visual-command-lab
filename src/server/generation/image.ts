export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ImageInfo {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

const ascii = (bytes: Uint8Array, start: number, text: string) =>
  bytes.length >= start + text.length && [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));
const be16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const be32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const le16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const le24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// Start-of-frame markers that carry dimensions (DHT C4, JPG C8 and DAC CC are not frames).
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function png(b: Uint8Array): ImageInfo | null {
  if (b.length < 24 || !PNG_SIGNATURE.every((byte, i) => b[i] === byte) || !ascii(b, 12, "IHDR")) return null;
  return { mimeType: "image/png", width: be32(b, 16), height: be32(b, 20) };
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // standalone marker, no length
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // scan or end before any frame header
    const length = be16(b, at + 2);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (at + 9 > b.length) return null;
      return { mimeType: "image/jpeg", height: be16(b, at + 5), width: be16(b, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  if (!ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ") && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { mimeType: "image/webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L") && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8X") && b.length >= 30) {
    return { mimeType: "image/webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/**
 * Identifies a JPEG, PNG or WebP image from its leading bytes and reads its dimensions from the
 * header, without decoding pixels. The declared upload type is never trusted. Returns null for any
 * other format, a truncated header or a zero dimension.
 */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes);
  if (!info || info.width < 1 || info.height < 1) return null;
  return info;
}
