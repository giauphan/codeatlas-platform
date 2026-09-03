const NAMED_PLACEHOLDER = /[:@\$][a-zA-Z_][a-zA-Z0-9_]*/g;

function formatPgQueryRegex(sql, params) {
  if (Array.isArray(params)) return { pgSql: sql, paramValues: params };

  let idx = 0;
  const nameToIdx = new Map();
  const paramNames = [];

  const pgSql = sql.replace(NAMED_PLACEHOLDER, (full) => {
    if (full.startsWith('$') && !isNaN(parseInt(full.slice(1), 10))) {
      return full;
    }
    const name = full.slice(1);
    if (!nameToIdx.has(name)) {
      idx++;
      nameToIdx.set(name, idx);
      paramNames.push(name);
    }
    return `$${nameToIdx.get(name)}`;
  });

  if (paramNames.length === 0) {
    return { pgSql: sql, paramValues: Object.values(params) };
  }

  const paramValues = paramNames.map((n) => params[n]);
  return { pgSql, paramValues };
}

console.log(formatPgQueryRegex("UPDATE t SET id2 = :id2 WHERE id = :id", {id: 1, id2: 2}));
