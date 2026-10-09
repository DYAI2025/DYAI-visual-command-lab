// Writes tests/fixtures/qualification/synthetic-figure-01.png: a programmatically drawn cartoon
// figure (flat shapes, no photo, no real person, no personal data). Deterministic: rerunning it
// reproduces the committed file byte for byte.
import fs from "node:fs";
import { encodePng } from "../tests/helpers/png.mjs";

const W = 512;
const H = 512;
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const inLimb = (x, y, ax, ay, bx, by, r) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r;
};

const SKIN = [236, 188, 150], HAIR = [70, 45, 30], SHIRT = [30, 150, 140], PANTS = [40, 50, 110], SHOE = [30, 30, 30];
const pixel = (x, y) => {
  if (inEllipse(x, y, 230, 145, 7, 8) || inEllipse(x, y, 282, 145, 7, 8)) return [20, 20, 20]; // eyes
  if (inEllipse(x, y, 256, 182, 22, 9) && y > 182) return [180, 60, 60]; // smile
  if (inEllipse(x, y, 256, 105, 62, 40) && y < 120) return HAIR;
  if (inEllipse(x, y, 256, 150, 58, 66)) return SKIN; // head
  if (inRect(x, y, 240, 210, 272, 232)) return SKIN; // neck
  if (inLimb(x, y, 190, 250, 140, 360, 18) || inLimb(x, y, 322, 250, 372, 360, 18)) return SHIRT; // arms
  if (inEllipse(x, y, 140, 372, 16, 16) || inEllipse(x, y, 372, 372, 16, 16)) return SKIN; // hands
  if (inRect(x, y, 190, 228, 322, 360)) return SHIRT; // torso
  if (inLimb(x, y, 225, 360, 215, 465, 24) || inLimb(x, y, 287, 360, 297, 465, 24)) return PANTS; // legs
  if (inEllipse(x, y, 210, 475, 32, 14) || inEllipse(x, y, 302, 475, 32, 14)) return SHOE;
  if (y > 488) return [200, 200, 205]; // floor
  return [238, 240, 244]; // background
};

const out = "tests/fixtures/qualification/synthetic-figure-01.png";
fs.writeFileSync(out, encodePng(W, H, pixel));
console.log(`wrote ${out}`);
