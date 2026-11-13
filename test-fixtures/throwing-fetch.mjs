// Preloaded with `node --import` by src/demo.test.ts: any network call from the
// server fails loudly and is logged to the file named by FETCH_LOG, so a test
// can assert that demo mode never reached for the network. Never shipped.
import { appendFileSync } from "node:fs";

globalThis.fetch = (input) => {
  if (process.env.FETCH_LOG) appendFileSync(process.env.FETCH_LOG, `${String(input)}\n`);
  throw new Error("fetch called: demo mode must not touch the network");
};
