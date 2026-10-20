// Minimal stand-in for @supabase/supabase-js used by edge functions.
// Tests inspect `supabaseStub.upserts` and can set `supabaseStub.upsertError`.
// `supabaseStub.tables` is a tiny in-memory database for select/insert/update/delete,
// `supabaseStub.signed` records storage signed-URL requests and `supabaseStub.removed`
// records storage deletes.
export const supabaseStub = {
  clients: [],
  upserts: [],
  upsertError: null,
  tables: {},
  signed: [],
  removed: [],
  reset() {
    this.clients = [];
    this.upserts = [];
    this.upsertError = null;
    this.tables = {};
    this.signed = [];
    this.removed = [];
  }
};

function query(table) {
  const rows = () => (supabaseStub.tables[table] ||= []);
  const filters = [];
  let op = "select";
  let values = null;
  let returning = false;

  const matching = () => rows().filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === "insert") {
      rows().push(...[].concat(values).map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    if (op === "update") {
      const hit = matching();
      hit.forEach((r) => Object.assign(r, values));
      return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
    }
    if (op === "delete") {
      const hit = matching();
      supabaseStub.tables[table] = rows().filter((r) => !hit.includes(r));
      return { data: returning ? hit : null, error: null };
    }
    return { data: matching().map((r) => ({ ...r })), error: null };
  };

  const builder = {
    select() { if (op !== "select") returning = true; return builder; },
    insert(v) { op = "insert"; values = v; return builder; },
    update(v) { op = "update"; values = v; return builder; },
    delete() { op = "delete"; return builder; },
    eq(col, v) { filters.push((r) => r[col] === v); return builder; },
    is(col, v) { filters.push((r) => (r[col] ?? null) === v); return builder; },
    in(col, vs) { filters.push((r) => vs.includes(r[col])); return builder; },
    lt(col, v) { filters.push((r) => r[col] < v); return builder; },
    limit() { return builder; },
    async maybeSingle() {
      const { data, error } = run();
      return { data: data?.[0] ?? null, error };
    },
    async upsert(row) {
      supabaseStub.upserts.push({ table, row });
      return { data: null, error: supabaseStub.upsertError };
    },
    then(resolve, reject) {
      return Promise.resolve(run()).then(resolve, reject);
    }
  };
  return builder;
}

export function createClient(url, key) {
  supabaseStub.clients.push({ url, key });
  return {
    from: query,
    rpc: async (fn) => {
      if (fn === "get_expired_handoff_files") {
        return { data: supabaseStub.expiredFiles || [], error: null };
      }
      return { data: null, error: null };
    },
    storage: {
      from(bucket) {
        return {
          async createSignedUrl(path, expiresIn) {
            supabaseStub.signed.push({ bucket, path, expiresIn });
            return { data: { signedUrl: `${url}/storage/v1/object/sign/${bucket}/${path}?token=t` }, error: null };
          },
          async remove(paths) {
            supabaseStub.removed.push({ bucket, paths });
            return { data: paths, error: null };
          }
        };
      }
    }
  };
}
