import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HEADER_FALLBACK_STORAGE_KEY,
  headerFallbackEnabled,
  loadHeaderFallback,
  setHeaderFallback,
} from "./header-fallback.ts";

describe("header fallback flag", () => {
  it("defaults off and stores only a non-secret tab flag", () => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem(key: string) {
          return store.get(key) ?? null;
        },
        setItem(key: string, value: string) {
          store.set(key, value);
        },
        removeItem(key: string) {
          store.delete(key);
        },
      },
    });

    assert.equal(loadHeaderFallback(), false);
    setHeaderFallback(true);
    assert.equal(headerFallbackEnabled(), true);
    assert.equal(store.get(HEADER_FALLBACK_STORAGE_KEY), "1");
    setHeaderFallback(false);
    assert.equal(headerFallbackEnabled(), false);
    assert.equal(store.has(HEADER_FALLBACK_STORAGE_KEY), false);
  });
});
