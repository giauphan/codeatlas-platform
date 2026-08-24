import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildInClause } from "../../src/database/utils.js";

test("buildInClause protects against injection by strictly parameterizing", () => {
  const ids = ["123", "456'; DROP TABLE users; --"];
  const base = { tenantId: "t1" };
  const { clause, binds } = buildInClause(ids, base);

  assert.equal(clause, ":id0,:id1");
  assert.equal(binds.tenantId, "t1");
  assert.equal(binds.id0, "123");
  assert.equal(binds.id1, "456'; DROP TABLE users; --");
  // The injection attempt is completely contained within the bind parameter
  // and will not execute as code.
});

test("buildInClause handles empty lists securely", () => {
  const { clause, binds } = buildInClause([], { base: 1 });
  assert.equal(clause, "NULL");
  assert.equal(binds.base, 1);
  assert.equal(Object.keys(binds).length, 1);
});
