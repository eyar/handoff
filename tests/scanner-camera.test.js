import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// Just enough DOM and camera for computerBridge.js. The fake <video> behaves
// like Chrome: play() rejects with AbortError if srcObject changes before
// playback starts, which is what surfaced as an unhandled rejection in the field.
const GUM_DELAY_MS = 20;
const PLAY_DELAY_MS = 10;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeElement() {
  const classes = new Set();
  return {
    textContent: "",
    focus() {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    }
  };
}

function fakeVideo() {
  let src = null;
  return {
    ...fakeElement(),
    paused: true,
    readyState: 0,
    HAVE_ENOUGH_DATA: 4,
    get srcObject() { return src; },
    set srcObject(value) { src = value; this.paused = true; },
    play() {
      const playing = src;
      return new Promise((resolve, reject) => setTimeout(() => {
        if (src !== playing) {
          const err = new Error("The play() request was interrupted by a new load request.");
          err.name = "AbortError";
          reject(err);
        } else {
          this.paused = false;
          resolve();
        }
      }, PLAY_DELAY_MS));
    }
  };
}

const elements = new Map([["#qr-scanner-video", fakeVideo()]]);
globalThis.document = {
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  }
};
globalThis.window = globalThis;
globalThis.history = { state: null, pushState() {}, back() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const tracks = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      async getUserMedia() {
        await wait(GUM_DELAY_MS);
        const track = {
          readyState: "live",
          stop() { this.readyState = "ended"; },
          getSettings: () => ({ facingMode: "environment", deviceId: "back" })
        };
        tracks.push(track);
        return { getTracks: () => [track], getVideoTracks: () => [track] };
      },
      async enumerateDevices() { return []; }
    }
  }
});

const bridge = await import("../public/modules/computerBridge.js");
const video = elements.get("#qr-scanner-video");
const liveTracks = () => tracks.filter((t) => t.readyState === "live").length;

afterEach(async () => {
  bridge.closeBridgeScanner(false);
  await wait(GUM_DELAY_MS + PLAY_DELAY_MS + 20);
  tracks.length = 0;
});

test("closing the scanner while the camera is opening releases the camera", async () => {
  const opening = bridge.openPairingScanner({ onScan() {} });
  await wait(GUM_DELAY_MS / 2);
  bridge.closeBridgeScanner(false);
  await opening;
  await wait(PLAY_DELAY_MS + 10);

  assert.equal(liveTracks(), 0, "no camera left running behind the closed scanner");
  assert.equal(video.srcObject, null);
});

test("closing the scanner while the preview is starting does not reject", async () => {
  const opening = bridge.openPairingScanner({ onScan() {} });
  await wait(GUM_DELAY_MS + PLAY_DELAY_MS / 2);
  bridge.closeBridgeScanner(false);

  await assert.doesNotReject(opening);
  assert.equal(liveTracks(), 0);
});

test("rapid camera switches end with one live camera and a playing preview", async () => {
  await bridge.openPairingScanner({ onScan() {} });
  const switches = [bridge.switchCamera(), bridge.switchCamera(), bridge.switchCamera()];

  await assert.doesNotReject(Promise.all(switches));
  assert.equal(liveTracks(), 1);
  assert.equal(video.paused, false);
});
