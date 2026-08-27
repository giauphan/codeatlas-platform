import test from "node:test";
import assert from "node:assert/strict";
import { countMatching } from "../../../src/utils/array.js";

test("countMatching", async (t) => {
  await t.test("counts elements matching condition", () => {
    const arr = [1, 2, 3, 4, 5];
    const count = countMatching(arr, (n) => n % 2 === 0);
    assert.strictEqual(count, 2);
  });

  await t.test("returns 0 for empty array", () => {
    const count = countMatching([], (n) => true);
    assert.strictEqual(count, 0);
  });

  await t.test("returns 0 when no elements match", () => {
    const arr = [1, 3, 5];
    const count = countMatching(arr, (n) => n % 2 === 0);
    assert.strictEqual(count, 0);
  });

  await t.test("returns length when all elements match", () => {
    const arr = [2, 4, 6];
    const count = countMatching(arr, (n) => n % 2 === 0);
    assert.strictEqual(count, 3);
  });
});
