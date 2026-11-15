// A form's values (UI contract), Mission Control's side, with a rows field (1.2): rows start
// from the bound list, are added empty and removed, a missing required input is refused before
// anything is sent, and what is sent is a list of objects under the field's key.
import assert from "node:assert/strict";
import test from "node:test";

import { emptyRow, formBody, formProblem, formValues } from "../ui/forms.js";

const fields = [
    {
        key: "mappings", label: "Folders", kind: "rows", required: true, value: "$.mappings",
        fields: [
            { key: "server", label: "On the server", kind: "text", required: true },
            { key: "phone", label: "On the phone", kind: "text" },
            { key: "on", label: "On", kind: "toggle" },
        ],
    },
    { key: "days", label: "Keep for", kind: "number", value: "$.days" },
];
const data = { mappings: [{ server: "/srv/a", phone: "DCIM" }, "not a row"], days: 30 };

test("rows start from the bound list, each with every input, as a copy", () => {
    const values = formValues(fields, { data });
    assert.deepEqual(values, { mappings: [{ server: "/srv/a", phone: "DCIM", on: false }], days: 30 });
    values.mappings[0].server = "/srv/b";
    assert.equal(data.mappings[0].server, "/srv/a", "editing a row never touches the page's data");
    assert.deepEqual(formValues(fields, { data: {} }), { mappings: [], days: null }, "an unbound value stays null, as before");
});

test("a row is added empty and removed, and the form sends a list of objects", () => {
    const values = formValues(fields, { data });
    values.mappings.push(emptyRow(fields[0].fields));
    assert.deepEqual(values.mappings[1], { server: "", phone: "", on: false });
    values.mappings[1].server = "/srv/c";
    values.mappings.splice(0, 1);
    const body = formBody(values);
    assert.deepEqual(body, { mappings: [{ server: "/srv/c", phone: "", on: false }], days: 30 });
    body.mappings[0].server = "changed";
    assert.equal(values.mappings[0].server, "/srv/c", "what is sent is a copy");
});

test("a rows field is refused without a row, or with a required input empty", () => {
    const values = formValues(fields, { data: { days: 1 } });
    assert.equal(formProblem(fields, values), "Folders needs at least one row.");
    values.mappings.push(emptyRow(fields[0].fields));
    assert.equal(formProblem(fields, values), "Folders, row 1: On the server is required.");
    values.mappings[0].server = "/srv/a";
    assert.equal(formProblem(fields, values), null);
    const plain = [{ key: "name", label: "Name", kind: "text", required: true }];
    assert.equal(formProblem(plain, { name: "" }), "Name is required.");
    assert.equal(formProblem([{ ...fields[0], required: false }], { mappings: [] }), null);
});
