import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// session.js reads and writes localStorage; give it an in-memory one.
class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
  get length() { return this.#data.size; }
}
globalThis.localStorage = new MemoryStorage();

const session = await import("../public/modules/session.js");
const constants = await import("../public/modules/constants.js");

const MB = 1024 * 1024;
const GB = 1024 * MB;
const ROOM = "abc123def4";

beforeEach(() => {
  localStorage.clear();
  console.warn = () => {};
});

test("tier limits and expiry windows", () => {
  assert.equal(constants.MAX_FILE_SIZE, 1.5 * GB, "file cap is 1.5 GB");
  assert.equal(constants.FILE_TTL_MS, 15 * 60 * 1000, "files expire after 15 minutes");
  assert.equal(constants.SESSION_TTL_MS, 2 * 60 * 60 * 1000, "saved sessions expire after 2 hours");
});

for (const role of ["Computer", "Phone"]) {
  const save = session[`save${role}Session`];
  const load = session[`getSaved${role}Session`];

  test(`${role.toLowerCase()} session round-trips and carries expiresAt`, () => {
    const createdAt = Date.now();
    save({ roomId: ROOM, createdAt });
    const saved = load();
    assert.equal(saved.roomId, ROOM);
    assert.equal(saved.expiresAt, createdAt + constants.SESSION_TTL_MS);
  });

  test(`${role.toLowerCase()} session survives just inside the TTL`, () => {
    save({ roomId: ROOM, createdAt: Date.now() - constants.SESSION_TTL_MS + 5_000 });
    assert.equal(load()?.roomId, ROOM);
  });

  test(`${role.toLowerCase()} session expires at the TTL and clears room data`, () => {
    save({ roomId: ROOM, createdAt: Date.now() - constants.SESSION_TTL_MS });
    session.saveCachedText(ROOM, "hello");

    assert.equal(load(), null);
    assert.equal(localStorage.length, 0, "session and cached text are removed");
  });

  test(`${role.toLowerCase()} session with corrupt data is discarded`, () => {
    const key = `handoff_${role.toLowerCase()}_session`;
    localStorage.setItem(key, JSON.stringify({ roomId: ROOM, createdAt: "yesterday" }));
    assert.equal(load(), null);
    assert.equal(localStorage.getItem(key), null);

    localStorage.setItem(key, "{not json");
    assert.equal(load(), null);
  });
}

test("cached files drop entries past their expiresAt", () => {
  const now = Date.now();
  session.saveCachedFiles(ROOM, [
    { id: "live", expiresAt: now + constants.FILE_TTL_MS },
    { id: "gone", expiresAt: now - 1 },
    { id: "no-expiry" }
  ]);
  assert.deepEqual(session.loadCachedFiles(ROOM).map((f) => f.id), ["live", "no-expiry"]);
});
