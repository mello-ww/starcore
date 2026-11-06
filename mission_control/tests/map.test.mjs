// The map block's pure helpers (UI contract 1.2), Mission Control's side: which items have a
// location, and how markers group as the map zooms. The map itself is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { boundsOf, clusterPoints, coordinates, viewportValue } from "../ui/map.js";

test("only a real coordinate pair is placed on the map", () => {
    assert.deepEqual(coordinates(48.8566, 2.3522), [48.8566, 2.3522]);
    assert.deepEqual(coordinates("-33.9", "18.4"), [-33.9, 18.4]);
    assert.equal(coordinates(null, 2), null);
    assert.equal(coordinates("", 2), null);
    assert.equal(coordinates(91, 0), null);
    assert.equal(coordinates(0, 181), null);
    assert.equal(coordinates("north", 3), null);
});

test("nearby items share a marker that separates as the map zooms in", () => {
    const points = [
        { lat: 48.8566, lon: 2.3522 },
        { lat: 48.8584, lon: 2.2945 },
        { lat: 51.5072, lon: -0.1276 },
    ];
    // a grid about 64 px wide on screen: whole regions when zoomed out, single spots zoomed in
    const far = clusterPoints(points, 1);
    assert.equal(far.reduce((total, cluster) => total + cluster.points.length, 0), 3);
    const paris = far.find((cluster) => cluster.points.length === 2);
    assert.ok(paris, "the two Paris items share a marker when zoomed out");
    assert.ok(Math.abs(paris.lat - 48.8575) < 0.001);
    assert.equal(clusterPoints(points, 6).length, 2);
    assert.equal(clusterPoints(points, 15).length, 3);
});

test("thousands of items stay a bounded number of markers when zoomed out", () => {
    const points = Array.from({ length: 5000 }, (_, index) => ({ lat: 45 + (index % 100) / 100, lon: 5 + Math.floor(index / 100) / 100 }));
    assert.ok(clusterPoints(points, 1).length <= 4);
    assert.ok(clusterPoints(points, 4).length <= 4);
    assert.ok(clusterPoints(points, 8).length <= 20);
    assert.ok(clusterPoints(points, 16).length > 1000);
});

test("a viewport is sent as the area on screen and its zoom", () => {
    assert.deepEqual(viewportValue([47.123456, 0.5, 49, 4.25], 6.4), { bbox: "47.12346,0.5,49,4.25", zoom: 6 });
    // a map wider than the world asks for all of it
    assert.equal(viewportValue([-60, -400, 70, 300], 1).bbox, "-60,-180,70,180");
    assert.deepEqual(boundsOf([1, 2, 3, 4]), [1, 2, 3, 4]);
    assert.equal(boundsOf([3, 2, 1, 4]), null);
    assert.equal(boundsOf(null), null);
});
