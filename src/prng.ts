// mulberry32: a small seeded generator (32-bit state, values in [0, 1)). The experiment schedule and the permutation test
// use it, so that the same seed always gives the same schedule and the same p-value, on every machine and Node version.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
