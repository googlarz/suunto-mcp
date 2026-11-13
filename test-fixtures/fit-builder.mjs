// Builds a small synthetic FIT file for tests (rest-profile unit and e2e tests):
// record messages with heart_rate (and optionally one developer field), plus a
// session message with start_time. No real workout data. Never shipped.
//
// buildFit({ records: [{ unixS, hr?, dev? }], sessionStartUnixS?, devField?: { name, units } })
//   unixS      absolute record time, Unix seconds
//   hr         heart_rate (omit for a record without HR)
//   dev        value of the developer field (uint8), when devField is given
//   sessionStartUnixS  session.start_time; omit to write no session message
const FIT_EPOCH_OFFSET_S = 631065600;

function crc16(bytes) {
  const table = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  let crc = 0;
  for (const b of bytes) {
    let tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[b & 0xf];
    tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[(b >> 4) & 0xf];
  }
  return crc;
}

const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const str16 = (s) => {
  const out = new Array(16).fill(0);
  [...Buffer.from(s, "utf8")].slice(0, 15).forEach((b, i) => (out[i] = b));
  return out;
};

// definition message: header 0x40 | local, reserved, little endian, global number, fields [(num, size, baseType)], developer fields [(num, size, devIdx)]
function definition(local, global, fields, devFields = []) {
  const out = [0x40 | local | (devFields.length ? 0x20 : 0), 0, 0, ...u16(global), fields.length, ...fields.flat()];
  if (devFields.length) out.push(devFields.length, ...devFields.flat());
  return out;
}

export function buildFit({ records, sessionStartUnixS, devField }) {
  const body = [];
  if (devField) {
    // developer_data_id (207): developer_id (0, byte), application_id (1, 16 bytes), developer_data_index (3, uint8)
    body.push(...definition(1, 207, [[0, 1, 0x0d], [1, 16, 0x0d], [3, 1, 0x02]]));
    body.push(0x01, 7, ...Buffer.from("synthetic-app-id!").subarray(0, 16), 0);
    // field_description (206): developer_data_index (0), field_definition_number (1), fit_base_type_id (2), field_name (3), units (8)
    body.push(...definition(2, 206, [[0, 1, 0x02], [1, 1, 0x02], [2, 1, 0x02], [3, 16, 0x07], [8, 16, 0x07]]));
    body.push(0x02, 0, 0, 2, ...str16(devField.name), ...str16(devField.units));
  }
  const recordFields = [[253, 4, 0x86], [3, 1, 0x02]];
  body.push(...definition(3, 20, recordFields, devField ? [[0, 1, 0]] : []));
  for (const r of records) {
    body.push(0x03, ...u32(r.unixS - FIT_EPOCH_OFFSET_S), r.hr ?? 0xff);
    if (devField) body.push(r.dev ?? 0xff);
  }
  if (sessionStartUnixS !== undefined) {
    // session (18): timestamp (253), start_time (2)
    const end = records.length ? records[records.length - 1].unixS : sessionStartUnixS;
    body.push(...definition(4, 18, [[253, 4, 0x86], [2, 4, 0x86]]));
    body.push(0x04, ...u32(end - FIT_EPOCH_OFFSET_S), ...u32(sessionStartUnixS - FIT_EPOCH_OFFSET_S));
  }
  const header = [14, 0x20, ...u16(100), ...u32(body.length), 0x2e, 0x46, 0x49, 0x54];
  header.push(...u16(crc16(header)));
  const all = [...header, ...body];
  return Buffer.from([...all, ...u16(crc16(all))]);
}
