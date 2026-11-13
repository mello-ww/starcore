// A list that arrives page by page (UI contract 1.2 `more`), Mission Control's side: the rows it
// shows, the pages it loads and the ones it drops. The drawing is checked in the browser.
import assert from "node:assert/strict";
import test from "node:test";

import { createListPaging } from "../ui/listpaging.js";

const block = {
    type: "list", items: "$.files", item: { title: "$.name" },
    more: { route: "view?path={$params.path}&part=files&cursor={$value}", cursor: "$.files_next" },
};

function pages(answers) {
    const asked = [];
    return {
        asked,
        load: (route) => {
            asked.push(route);
            const answer = answers.shift();
            return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
        },
    };
}

const scope = (data, path = "/srv") => ({ data, page: data, params: { path }, state: {} });

test("a list without more shows its page data as it is", () => {
    const paging = createListPaging(pages([]));
    const plain = { type: "list", items: "$.files", item: { title: "$.name" } };
    assert.deepEqual(paging.rows(plain, scope({ files: [{ name: "a" }] })), [{ name: "a" }]);
});

test("each page comes from the cursor the provider gave, until it gives none", async () => {
    const server = pages([
        { files: [{ name: "c" }, { name: "d" }], files_next: "d" },
        { files: [{ name: "e" }], files_next: null },
    ]);
    const paging = createListPaging(server);
    const first = scope({ files: [{ name: "a" }, { name: "b" }], files_next: "b" });
    assert.deepEqual(paging.rows(block, first).map((row) => row.name), ["a", "b"]);
    assert.equal(paging.status(block).more, true);

    assert.deepEqual((await paging.loadMore(block)).map((row) => row.name), ["c", "d"]);
    assert.deepEqual((await paging.loadMore(block)).map((row) => row.name), ["e"]);
    assert.deepEqual(server.asked, ["view?path=%2Fsrv&part=files&cursor=b", "view?path=%2Fsrv&part=files&cursor=d"]);
    assert.equal(paging.status(block).more, false);
    assert.deepEqual(await paging.loadMore(block), []);
    assert.deepEqual(paging.rows(block, first).map((row) => row.name), ["a", "b", "c", "d", "e"]);
});

test("a row is never shown twice, and the same cursor again ends the list", async () => {
    const paging = createListPaging(pages([{ files: [{ name: "b" }, { name: "c" }], files_next: "b" }]));
    paging.rows(block, scope({ files: [{ name: "a" }, { name: "b" }], files_next: "b" }));
    assert.deepEqual((await paging.loadMore(block)).map((row) => row.name), ["c"]);
    assert.equal(paging.status(block).more, false);
});

test("one page at a time", async () => {
    const server = pages([{ files: [{ name: "b" }], files_next: null }]);
    const paging = createListPaging(server);
    paging.rows(block, scope({ files: [{ name: "a" }], files_next: "a" }));
    const first = paging.loadMore(block);
    assert.equal(paging.status(block).loading, true);
    const second = paging.loadMore(block);
    assert.deepEqual((await first).map((row) => row.name), ["b"]);
    assert.deepEqual(await second, []);
    assert.equal(server.asked.length, 1);
});

test("a page that arrives after the list changed is dropped", async () => {
    let release;
    const paging = createListPaging({ load: () => new Promise((resolve) => { release = resolve; }) });
    paging.rows(block, scope({ files: [{ name: "a" }], files_next: "a" }, "/one"));
    const pending = paging.loadMore(block);
    const other = scope({ files: [{ name: "x" }], files_next: null }, "/two");
    paging.rows(block, other);
    release({ files: [{ name: "late" }], files_next: "late" });
    assert.deepEqual(await pending, []);
    assert.deepEqual(paging.rows(block, other).map((row) => row.name), ["x"]);
    assert.equal(paging.status(block).more, false);
});

test("a refresh of the same list loads back as many pages as it had", async () => {
    const paging = createListPaging(pages([
        { files: [{ name: "b" }], files_next: "b" },
        { files: [{ name: "b" }], files_next: "b" },
    ]));
    paging.rows(block, scope({ files: [{ name: "a" }], files_next: "a" }));
    await paging.loadMore(block);
    paging.rows(block, scope({ files: [{ name: "a" }], files_next: "a" }));  // fresh data, same folder
    assert.equal(paging.status(block).restoring, true);
    await paging.loadMore(block);
    assert.equal(paging.status(block).restoring, false);
});

test("a failed page says why, and the next try asks again", async () => {
    const server = pages([new Error("Server unreachable"), { files: [{ name: "b" }], files_next: null }]);
    const paging = createListPaging(server);
    paging.rows(block, scope({ files: [{ name: "a" }], files_next: "a" }));
    assert.deepEqual(await paging.loadMore(block), []);
    assert.equal(paging.status(block).error, "Server unreachable");
    assert.equal(paging.status(block).more, true);
    assert.deepEqual((await paging.loadMore(block)).map((row) => row.name), ["b"]);
    assert.equal(paging.status(block).error, null);
});

test("a page route outside the Satellite is never asked for", async () => {
    const server = pages([]);
    const paging = createListPaging(server);
    const outside = { ...block, more: { route: "../other?cursor={$value}", cursor: "$.next" } };
    paging.rows(outside, scope({ files: [{ name: "a" }], next: "a" }));
    assert.deepEqual(await paging.loadMore(outside), []);
    assert.equal(server.asked.length, 0);
    assert.match(paging.status(outside).error, /outside/);
});
