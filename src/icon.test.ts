import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { buildIconPng, buildStrengthIconPng, buildGuideZip, buildStrengthGuideZip } from "./guide-zip.js";

function chunks(png: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let o = 8;
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    out[png.subarray(o + 4, o + 8).toString("ascii")] = png.subarray(o + 8, o + 8 + len);
    o += 12 + len;
  }
  return out;
}

// Decodes an 8-bit RGB PNG that uses filter 0 or 1 (the only ones the builder emits).
function pixel(png: Buffer, x: number, y: number): [number, number, number] {
  const raw = inflateSync(chunks(png).IDAT);
  const stride = 1 + 300 * 3;
  const row = y * stride;
  const filter = raw[row];
  const rgb: number[] = [];
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let i = 0; i <= x; i++) {
      const b = raw[row + 1 + i * 3 + c];
      v = filter === 1 ? (v + b) & 0xff : b;
    }
    rgb.push(v);
  }
  assert.ok(filter === 0 || filter === 1);
  return rgb as [number, number, number];
}

// Extracts a STORE entry from the zip by name.
function zipEntry(zip: Buffer, name: string): Buffer {
  let o = 0;
  while (zip.readUInt32LE(o) === 0x04034b50) {
    const size = zip.readUInt32LE(o + 18);
    const nameLen = zip.readUInt16LE(o + 26);
    const extraLen = zip.readUInt16LE(o + 28);
    const n = zip.subarray(o + 30, o + 30 + nameLen).toString("utf8");
    const start = o + 30 + nameLen + extraLen;
    if (n === name) return zip.subarray(start, start + size);
    o = start + size;
  }
  throw new Error(`no ${name}`);
}

test("buildStrengthIconPng: valid 300x300 8-bit RGB PNG with full-size IDAT", () => {
  const png = buildStrengthIconPng();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const c = chunks(png);
  assert.equal(c.IHDR.readUInt32BE(0), 300);
  assert.equal(c.IHDR.readUInt32BE(4), 300);
  assert.equal(c.IHDR[8], 8);
  assert.equal(c.IHDR[9], 2);
  assert.equal(inflateSync(c.IDAT).length, 300 * (1 + 900));
  assert.ok(png.length < 40 * 1024, `size ${png.length}`);
});

test("buildStrengthIconPng: deterministic", () => {
  assert.ok(buildStrengthIconPng().equals(buildStrengthIconPng()));
});

const white = (p: [number, number, number]) => p[1] > 240;

test("buildStrengthIconPng: side-view barbell geometry", () => {
  const png = buildStrengthIconPng();
  assert.ok(white(pixel(png, 150, 150)), "centre of the bar");
  assert.ok(white(pixel(png, 82, 80)), "plate 1 (left) above the bar");
  assert.ok(white(pixel(png, 217, 80)), "plate 1 (right) above the bar");
  assert.ok(white(pixel(png, 87, 230)), "plate 1 reaches y~245");
  assert.ok(white(pixel(png, 12, 150)), "left sleeve tip");
  assert.ok(white(pixel(png, 287, 150)), "right sleeve tip");
  assert.ok(!white(pixel(png, 71, 100)), "gap between plate 1 and plate 2");
  assert.ok(white(pixel(png, 63, 100)), "plate 2 (left)");
  assert.ok(!white(pixel(png, 150, 100)), "far above the grip is background");
  assert.ok(!white(pixel(png, 150, 200)), "far below the grip is background");
  assert.ok(!white(pixel(png, 40, 120)), "above the thin outer bar is background");
});

test("buildStrengthIconPng: plates graduate in height, largest next to the grip", () => {
  const png = buildStrengthIconPng();
  const colHeight = (x: number) => {
    let n = 0;
    for (let y = 0; y < 300; y++) if (white(pixel(png, x, y))) n++;
    return n;
  };
  const h1 = colHeight(82); // plate 1
  const h2 = colHeight(63); // plate 2
  const h3 = colHeight(47); // plate 3
  const hc = colHeight(35); // collar
  const hs = colHeight(15); // sleeve tip
  assert.ok(h1 > h2 && h2 > h3 && h3 > hc && hc > hs, `${h1} ${h2} ${h3} ${hc} ${hs}`);
  assert.ok(h1 > 170 && hs < 20);
});

test("buildStrengthIconPng: left and right are mirrors (rows 150 and 60)", () => {
  const png = buildStrengthIconPng();
  for (const y of [150, 60]) {
    for (let x = 0; x < 150; x++) {
      assert.equal(white(pixel(png, x, y)), white(pixel(png, 299 - x, y)), `row ${y} x ${x}`);
    }
  }
  // row 60 crosses plate 1 only
  const xs = [];
  for (let x = 0; x < 300; x++) if (white(pixel(png, x, 60))) xs.push(x);
  assert.ok(xs.length >= 30 && xs.length <= 40, `${xs.length}`); // rounded corners trim a few px
  assert.ok(xs.every((x) => (x >= 72 && x <= 91) || (x >= 208 && x <= 227)));
});

test("buildStrengthIconPng: blue to violet gradient corners", () => {
  const png = buildStrengthIconPng();
  const tl = pixel(png, 0, 0);
  const br = pixel(png, 299, 299);
  assert.ok(tl[2] > tl[0] && tl[2] > tl[1], `top-left bluish ${tl}`);
  assert.ok(br[0] > br[1] && br[2] > br[1] && br[0] > tl[0], `bottom-right violet ${br}`);
  assert.ok(tl[1] < 150 && br[1] < 150, "corners are saturated, not near white");
});

test("strength guide zip carries the new icon; other guides keep the grey one", () => {
  const plan = { title: "T", date: "2026-11-04", exercises: [{ name: "Squat", sets: 3, restSec: 90, detail: "100kg 3x5" }] };
  const strength = zipEntry(buildStrengthGuideZip(plan, "app"), "icon.png");
  assert.ok(strength.equals(buildStrengthIconPng()));
  assert.ok(!strength.equals(buildIconPng()));
  const workout = zipEntry(
    buildGuideZip({ title: "T", date: "2026-11-04", exercises: [{ name: "Squat", detail: "x" }] }, "app"),
    "icon.png",
  );
  assert.ok(workout.equals(buildIconPng()));
});
