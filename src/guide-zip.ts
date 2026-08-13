// Builds the 3-file ZIP (manifest.json + guide.json + icon.png) required by
// POST /v2/guides/files. Uses STORE (uncompressed) entries — no deflate
// needed, keeps this dependency-free while still producing a valid PKZIP.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(files: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + file.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, end]);
}

// Minimal 8x8 solid-gray PNG — Guide API requires an icon.png but doesn't
// need it to look like anything; watch UI doesn't render a per-guide icon.
function buildIconPng(): Buffer {
  const size = 300; // Guide API requires exactly 300x300
  const rowBytes = 1 + size * 3; // filter byte + RGB
  const raw = Buffer.alloc(rowBytes * size, 0);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = raw[px + 1] = raw[px + 2] = 0x88;
    }
  }

  function chunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DEFAULT_REST_SECONDS = 90;

export interface GuideExercise {
  name: string;
  detail: string;
  restSeconds?: number; // rest after this exercise, before the next one. Default 90.
}

export interface GuidePlan {
  title: string;
  date: string; // YYYY-MM-DD
  exercises: GuideExercise[];
}

// One text step per exercise + one rest step between exercises + a closing
// "done" step. Confirmed against apizone.suunto.com/suuntoplus-guide-description:
// - a step advances via its own "transitions" array — { condition: { type:
//   "manualLap" } } jumps to the next step on lap press. createManualLap is
//   a DIFFERENT, unrelated property (only logs a lap marker for HR-window
//   averaging) — it does not advance anything.
// - "notification" is an optional per-step object (title/text) shown with a
//   vibrate/sound when that step starts — used here to confirm "next up" so
//   the lap press's effect is felt, not just seen.
// - rest steps auto-advance via a stepDuration condition, OR'd with manualLap
//   so the user can skip the rest early.
export function buildGuideJson(plan: GuidePlan, ownerAppName: string) {
  const exercises = plan.exercises;
  const steps: Record<string, unknown>[] = [];

  exercises.forEach((ex, i) => {
    const isLast = i === exercises.length - 1;
    steps.push({
      type: "fields",
      title: `${i + 1}/${exercises.length}`,
      fields: [{ type: "text", value: stepText(ex) }],
      notification: { title: "NEXT", text: truncate(ex.name, 54) },
      transitions: [{ condition: { type: "manualLap" } }],
    });

    if (!isLast) {
      const rest = ex.restSeconds ?? DEFAULT_REST_SECONDS;
      steps.push({
        type: "fields",
        title: "REST",
        fields: [{ type: "stepDurationCountdown", value: rest }],
        transitions: [
          {
            condition: {
              type: "or",
              conditions: [
                { type: "stepDuration", value: rest },
                { type: "manualLap" },
              ],
            },
          },
        ],
      });
    }
  });

  steps.push({
    type: "fields",
    title: "DONE",
    fields: [{ type: "text", value: "Session complete" }],
  });

  return {
    type: "sequence",
    name: plan.title,
    description: `${exercises.length} exercises`,
    shortDescription: plan.title,
    localDate: plan.date,
    usage: "workout",
    owner: ownerAppName,
    steps,
  };
}

// Step text field is capped at 54 characters (confirmed). Two lines via \n
// reads better than one long truncated line.
function stepText(ex: GuideExercise): string {
  return truncate(`${ex.name}\n${ex.detail}`, 54);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

export function buildGuideZip(plan: GuidePlan, ownerAppName: string): Buffer {
  const manifest = {
    name: plan.title,
    type: "sequence",
    owner: ownerAppName,
    description: `Gym Coach plan for ${plan.date}`,
  };
  const guide = buildGuideJson(plan, ownerAppName);

  return buildZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "guide.json", data: Buffer.from(JSON.stringify(guide), "utf8") },
    { name: "icon.png", data: buildIconPng() },
  ]);
}
