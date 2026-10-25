import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateEncryptionKey } from "../public/modules/crypto.js";
import { state } from "../public/modules/state.js";
import { sealChannel } from "../public/modules/sealedBroadcast.js";

// A fake Realtime channel: whatever is sent is recorded as the relay sees it
// and delivered to the handlers registered on the receiving channel.
function fakeRelay() {
  const seen = [];
  const handlers = [];
  const channel = {
    async send(message) {
      seen.push(structuredClone(message));
      for (const h of handlers) {
        if (h.event === message.event) h.callback({ type: "broadcast", event: message.event, payload: message.payload });
      }
      return "ok";
    },
    on(type, filter, callback) {
      handlers.push({ event: filter.event, callback });
      return this;
    }
  };
  return { channel, seen };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const FILE = {
  fileId: "f1",
  originalName: "tax_return_2025.pdf",
  mimeType: "application/pdf",
  size: 1234,
  downloadUrl: "https://example.r2.cloudflarestorage.com/room/f1?X-Amz-Signature=abc"
};

beforeEach(async () => {
  state.cryptoKey = await generateEncryptionKey();
});

test("file events reach the peer intact but the relay never sees names, types or links", async () => {
  const { channel, seen } = fakeRelay();
  sealChannel(channel);
  const received = [];
  channel.on("broadcast", { event: "file:ready" }, ({ payload }) => received.push(payload));

  assert.equal(await channel.send({ type: "broadcast", event: "file:ready", payload: FILE }), "ok");
  await tick();

  assert.deepEqual(received, [FILE]);
  const relayed = JSON.stringify(seen);
  for (const leak of ["tax_return", "application/pdf", "X-Amz", "1234"]) {
    assert.ok(!relayed.includes(leak), `relay saw ${leak}`);
  }
});

test("peer:hello keeps its role readable and seals only the file list", async () => {
  const { channel, seen } = fakeRelay();
  sealChannel(channel);
  const received = [];
  channel.on("broadcast", { event: "peer:hello" }, ({ payload }) => received.push(payload));

  await channel.send({ type: "broadcast", event: "peer:hello", payload: { role: "phone", existingFiles: [FILE] } });
  await tick();

  assert.equal(seen[0].payload.role, "phone");
  assert.ok(!JSON.stringify(seen).includes("tax_return"));
  assert.deepEqual(received, [{ role: "phone", existingFiles: [FILE] }]);
});

test("unsealed payloads from the server-side Shortcut upload pass through", async () => {
  const { channel } = fakeRelay();
  const rawSend = channel.send.bind(channel);
  sealChannel(channel);
  const received = [];
  channel.on("broadcast", { event: "file:ready" }, ({ payload }) => received.push(payload));

  await rawSend({ type: "broadcast", event: "file:ready", payload: FILE });
  await tick();

  assert.deepEqual(received, [FILE]);
});

test("a payload sealed with another room's key is dropped, not delivered garbled", async () => {
  const { channel } = fakeRelay();
  sealChannel(channel);
  const received = [];
  channel.on("broadcast", { event: "file:ready" }, ({ payload }) => received.push(payload));
  const warn = console.warn;
  console.warn = () => {};
  const error = console.error;
  console.error = () => {};

  const sending = channel.send({ type: "broadcast", event: "file:ready", payload: FILE });
  state.cryptoKey = await generateEncryptionKey();
  await sending;
  await tick();

  console.warn = warn;
  console.error = error;
  assert.deepEqual(received, []);
});

test("handlers run in arrival order", async () => {
  const { channel } = fakeRelay();
  sealChannel(channel);
  const order = [];
  channel.on("broadcast", { event: "file:upload_started" }, () => order.push("started"));
  channel.on("broadcast", { event: "file:ready" }, () => order.push("ready"));
  channel.on("broadcast", { event: "peer:ack" }, () => order.push("ack"));

  await Promise.all([
    channel.send({ type: "broadcast", event: "file:upload_started", payload: FILE }),
    channel.send({ type: "broadcast", event: "peer:ack", payload: { fromRole: "computer" } }),
    channel.send({ type: "broadcast", event: "file:ready", payload: FILE })
  ]);
  await tick();

  assert.deepEqual(order, ["started", "ack", "ready"]);
});
