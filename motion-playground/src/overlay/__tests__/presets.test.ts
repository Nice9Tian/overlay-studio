// @ts-ignore
import assert from "node:assert";
import { listPresets, addPreset, removePreset, subscribePresets } from "../presets";
// @ts-ignore
import { randomUUID } from "node:crypto";

// Fake localStorage and window for testing
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) || null,
  setItem: (k: string, v: string) => store.set(k, v),
  removeItem: (k: string) => store.delete(k),
  clear: () => store.clear(),
  length: 0,
  key: () => null,
} as any;

if (typeof globalThis.crypto === "undefined") {
  (globalThis as any).crypto = { randomUUID };
}

// Test basic add, list, remove
const p1 = addPreset({ name: "P1", kind: "test", params: {}, source: "user" });
assert.strictEqual(listPresets().length, 1);
assert.strictEqual(listPresets()[0].name, "P1");

// Test overwrite by name
const p2 = addPreset({ name: "P1", kind: "test2", params: { changed: true }, source: "ai" });
assert.strictEqual(p2.kind, "test2");
assert.strictEqual(listPresets().length, 1);
assert.strictEqual(listPresets()[0].kind, "test2");
assert.strictEqual(listPresets()[0].id, p1.id);

// Test subscription
let notified = 0;
const unsub = subscribePresets(() => {
  notified++;
});

const p3 = addPreset({ name: "P2", kind: "test", params: {}, source: "ai" });
assert.strictEqual(notified, 1);

removePreset(p3.id);
assert.strictEqual(notified, 2);
assert.strictEqual(listPresets().length, 1);

unsub();
addPreset({ name: "P3", kind: "test", params: {}, source: "ai" });
assert.strictEqual(notified, 2); // Unsubscribed, so not incremented

console.log("presets tests passed.");
