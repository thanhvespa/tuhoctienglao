/**
 * Browser JavaScript is never `require`d by the server tests, so a syntax
 * error there (e.g. a stray line after a template string) would only show up
 * as a blank app in production. Parse every shipped front-end script here.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const FILES = [
  "Slide-Tuong-Tac/app.js",
  "Slide-Tuong-Tac/sw.js",
  "Landing-Page/landing.js",
  "Template-Da-Ngon-Ngu/Slide-Tuong-Tac/app.js",
  "Template-Da-Ngon-Ngu/Slide-Tuong-Tac/sw.js",
];

for (const rel of FILES) {
  test(`front-end script parses: ${rel}`, (t) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return t.skip("file not present");
    const code = fs.readFileSync(abs, "utf8");
    assert.doesNotThrow(() => new vm.Script(code, { filename: rel }), `${rel} has a syntax error`);
  });
}
