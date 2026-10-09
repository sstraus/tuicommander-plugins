import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf8"));
for (const id of ["mdkb-dashboard", "cache-keepalive"]) {
  test(`catalog version matches shipped ${id} manifest`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`./${id}/manifest.json`, import.meta.url), "utf8"));
    assert.equal(registry.find((entry) => entry.id === id).latestVersion, manifest.version);
  });
}
