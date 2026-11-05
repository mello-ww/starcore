// The media picker's pure helpers (the pick action, UI contract 1.2), Mission Control's side:
// what a pick returns, and which route it lists from. The dialog itself is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { isSafeRoute } from "../ui/contract.js";
import { listRoute, references } from "../ui/picker.js";

const provider = { satellite: "Gallery", version: 1, enabled: true, operations: { list: "media", thumbnail: "thumbs" } };

test("a pick returns references with the provider's identity, never paths", () => {
    const picked = references(provider, "media.gallery", [{ id: 7, kind: "video", title: "a.mp4", path: "/srv/a.mp4" }, { id: "b" }]);
    assert.deepEqual(picked, [
        { provider: "Gallery", capability: "media.gallery", id: "7", kind: "video" },
        { provider: "Gallery", capability: "media.gallery", id: "b", kind: "image" },
    ]);
});

test("the picker lists the accepted kinds from the provider's own route, as a safe route", () => {
    assert.ok(isSafeRoute(listRoute(provider, undefined)));
    assert.equal(listRoute(provider, ["image"]), "media?kinds=image");
    assert.equal(listRoute(provider, undefined), "media?kinds=image%2Cvideo");
    assert.equal(listRoute({ ...provider, operations: { list: "media?all=1" } }, ["video", "audio"]), "media?all=1&kinds=video");
    assert.equal(listRoute({ ...provider, operations: { list: "../other" } }, ["image"]), null);
});
