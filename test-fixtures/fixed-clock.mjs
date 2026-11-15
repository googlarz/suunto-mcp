// Preloaded with `node --import` by src/contract.test.ts: freezes the server's clock at FIXED_NOW (an ISO instant), so
// demo mode, which builds its data around "today", returns the same data on every day the test runs. Never shipped.
const RealDate = Date;
const fixed = RealDate.parse(process.env.FIXED_NOW ?? "2026-11-13T19:00:00Z");

globalThis.Date = new Proxy(RealDate, {
  construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [fixed], newTarget),
  apply: () => new RealDate(fixed).toString(),
  get: (target, prop, receiver) => (prop === "now" ? () => fixed : Reflect.get(target, prop, receiver)),
});
