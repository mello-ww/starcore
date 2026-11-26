// The shared motion's arithmetic: when the accent moves, and where a move under way has got to.
import test from "node:test";
import assert from "node:assert/strict";
import { MOVE_MS, inFlight, slides } from "../ui/motion.js";

const a = { x: 0, y: 0, width: 60, height: 36 };
const b = { x: 100, y: 0, width: 80, height: 36 };

test("the accent moves only between two different places", () => {
    assert.equal(slides(a, b), true);
    assert.equal(slides(a, { ...a }), false);
    assert.equal(slides(null, b), false);
    assert.equal(slides(a, { ...a, y: 48 }), true);
});

test("a move under way carries on from where it has got to", () => {
    const move = { from: a, to: b };
    const start = inFlight(move, 0);
    assert.deepEqual(start.at, a);
    assert.equal(start.remaining, MOVE_MS);
    const half = inFlight(move, MOVE_MS / 2);
    assert.ok(half.at.x > 50 && half.at.x < 100, "eased: past half way at half time");
    assert.equal(half.remaining, MOVE_MS / 2);
});

test("a finished or still move is not in flight", () => {
    assert.equal(inFlight({ from: a, to: b }, MOVE_MS), null);
    assert.equal(inFlight({ from: a, to: a }, 10), null);
    assert.equal(inFlight(null, 10), null);
});
