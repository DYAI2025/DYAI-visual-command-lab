import assert from "node:assert/strict";
import test from "node:test";

import { inspectImage } from "../src/server/generation/image.ts";
import { encodePng } from "./helpers/png.mjs";

const u8 = (...parts) => Uint8Array.from(parts.flat());
const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

function jpeg(width, height, { sof = 0xc0, extraSegments = [] } = {}) {
  const app0 = [0xff, 0xe0, ...be16(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sofSeg = [0xff, sof, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return u8([0xff, 0xd8], app0, ...extraSegments, sofSeg, [0xff, 0xda, 0, 2], [0xff, 0xd9]);
}

function webpLossy(width, height) {
  const vp8 = [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0];
  return u8(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8 "), [vp8.length, 0, 0, 0], vp8);
}

function webpLossless(width, height) {
  const bits = (width - 1) | ((height - 1) << 14);
  const vp8l = [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0, 0];
  return u8(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8L"), [vp8l.length, 0, 0, 0], vp8l);
}

function webpExtended(width, height) {
  const vp8x = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  return u8(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8X"), [vp8x.length, 0, 0, 0], vp8x);
}

test("PNG type and dimensions come from the IHDR chunk, not from a declared type", () => {
  assert.deepEqual(inspectImage(encodePng(3, 2, () => [255, 0, 0])), { mimeType: "image/png", width: 3, height: 2 });
});

test("JPEG dimensions come from the first SOF segment after other segments", () => {
  const app1 = [0xff, 0xe1, ...be16(6), 1, 2, 3, 4];
  assert.deepEqual(inspectImage(jpeg(640, 480, { extraSegments: [app1] })), { mimeType: "image/jpeg", width: 640, height: 480 });
  assert.deepEqual(inspectImage(jpeg(1024, 768, { sof: 0xc2 })), { mimeType: "image/jpeg", width: 1024, height: 768 });
});

test("JPEG without a frame header before scan data is rejected", () => {
  assert.equal(inspectImage(u8([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9])), null);
});

test("WebP lossy, lossless and extended headers report dimensions", () => {
  assert.deepEqual(inspectImage(webpLossy(800, 600)), { mimeType: "image/webp", width: 800, height: 600 });
  assert.deepEqual(inspectImage(webpLossless(321, 123)), { mimeType: "image/webp", width: 321, height: 123 });
  assert.deepEqual(inspectImage(webpExtended(4096, 2048)), { mimeType: "image/webp", width: 4096, height: 2048 });
});

test("unknown, truncated and zero-sized images are rejected", () => {
  assert.equal(inspectImage(u8(ascii("GIF89a"), [1, 0, 1, 0])), null);
  assert.equal(inspectImage(u8(ascii("<svg xmlns='http://www.w3.org/2000/svg'/>"))), null);
  assert.equal(inspectImage(new Uint8Array(0)), null);
  assert.equal(inspectImage(encodePng(3, 2, () => [0, 0, 0]).subarray(0, 20)), null);
  assert.equal(inspectImage(jpeg(0, 10)), null);
  assert.equal(inspectImage(u8(ascii("RIFF"), [0, 0, 0, 0], ascii("WEBP"), ascii("VP8 "), [2, 0, 0, 0], [0, 0])), null);
});
