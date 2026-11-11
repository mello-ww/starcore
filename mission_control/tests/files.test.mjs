// The download and share actions (UI contract 1.2), Mission Control's side: the name a file is
// saved under, and whether this browser can hand files to the system share sheet. Saving and
// sharing themselves are checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { canShareFiles, fileName } from "../ui/files.js";

test("a file is named from the document, made safe, else from its route", () => {
    assert.equal(fileName("IMG_0042.jpg", "originals/abc"), "IMG_0042.jpg");
    assert.equal(fileName("  holiday photo.png ", "originals/abc"), "holiday photo.png");
    // never a path, a reserved character or a control character
    assert.equal(fileName("../../etc/passwd", "originals/abc"), "_.._etc_passwd");
    assert.equal(fileName('a:b*c?"d<e>f|g\\h\u0000.txt', "x"), "a_b_c__d_e_f_g_h_.txt");
    assert.equal(fileName("", "originals/abc?size=2"), "abc");
    assert.equal(fileName(null, "reports/latest"), "latest");
    assert.equal(fileName("...", "files/"), "download");
    assert.equal(fileName("x".repeat(300), "y").length, 120);
});

test("sharing files needs a browser that says it can share them", () => {
    assert.equal(canShareFiles(undefined), false);
    assert.equal(canShareFiles({}), false);
    assert.equal(canShareFiles({ share: () => {}, canShare: () => false }), false);
    assert.equal(canShareFiles({ share: () => {}, canShare: ({ files }) => files.length === 1 }), true);
    assert.equal(canShareFiles({ share: () => {}, canShare: () => { throw new Error("no"); } }), false);
});
