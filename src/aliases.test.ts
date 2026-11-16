import { test } from "node:test";
import assert from "node:assert/strict";
import { aliased, requiredAliased } from "./aliases.js";

test("aliased: either name gives the value, both with the same value are fine, both with different values are an error naming both", () => {
  assert.equal(aliased({ from: "a" }, "from", "since"), "a");
  assert.equal(aliased({ since: "b" }, "from", "since"), "b");
  assert.equal(aliased({ from: "a", since: "a" }, "from", "since"), "a");
  assert.equal(aliased({}, "from", "since"), undefined);
  assert.throws(() => aliased({ from: "a", since: "b" }, "from", "since"), /from and since mean the same thing but differ \("a" and "b"\): give one of them \(from is preferred\)/);
  assert.equal(aliased({ from: "", since: undefined }, "from", "since"), "", "an empty string is a value, not a gap");
  assert.equal(aliased({ from: 0, since: 0 }, "from", "since"), 0);
});

test("requiredAliased: neither given is an error naming both", () => {
  assert.equal(requiredAliased({ startdate: "x" }, "from", "startdate"), "x");
  assert.equal(requiredAliased({ from: "y" }, "from", "startdate"), "y");
  assert.throws(() => requiredAliased({}, "from", "startdate"), /from \(or startdate\) is required/);
  assert.throws(() => requiredAliased({ from: "a", startdate: "b" }, "from", "startdate"), /differ/);
});
