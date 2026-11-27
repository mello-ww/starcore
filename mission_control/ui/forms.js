// A form block's values (UI contract, docs/reference/ui-contract.md "Blocks"): what each field starts
// with, an empty row of a `rows` field (1.2), and what keeps a submit from going out. Pure, so
// mission_control/tests/forms.test.mjs checks it; the renderer draws the inputs.

import { resolve } from "./contract.js";

function emptyValue(field) {
    if (field.kind === "toggle") {
        return false;
    }
    if (field.kind === "rows") {
        return [];
    }
    return "";
}

/** A new row of a rows field: each of its inputs empty (a toggle off). */
export function emptyRow(fields) {
    return Object.fromEntries((fields || []).map((field) => [field.key, emptyValue(field)]));
}

/** What a form starts with: each field's bound value, or empty. A rows field's value is a
 * fresh list of rows, each with every input of the row, so editing one never touches the data
 * it came from. */
export function formValues(fields, scope) {
    return Object.fromEntries((fields || []).map((field) => {
        const bound = field.value !== undefined ? resolve(field.value, scope) : undefined;
        if (field.kind === "rows") {
            const rows = Array.isArray(bound) ? bound : [];
            return [field.key, rows.filter((row) => row && typeof row === "object" && !Array.isArray(row))
                .map((row) => ({ ...emptyRow(field.fields), ...row }))];
        }
        return [field.key, bound !== undefined ? bound : emptyValue(field)];
    }));
}

function missing(value) {
    return value === "" || value === null || value === undefined;
}

/** Why a form can't be sent yet (a required field empty, a rows field with no row, a row with a
 * required input empty), or null. */
export function formProblem(fields, values) {
    const empty = [];
    for (const field of fields || []) {
        const value = values[field.key];
        if (field.kind === "rows") {
            const rows = Array.isArray(value) ? value : [];
            if (field.required && !rows.length) {
                return `${field.label} needs at least one row.`;
            }
            for (const [index, row] of rows.entries()) {
                const blank = (field.fields || []).filter((input) => input.required && missing(row[input.key]));
                if (blank.length) {
                    return `${field.label}, row ${index + 1}: ${blank.map((input) => input.label).join(", ")} `
                        + `${blank.length === 1 ? "is" : "are"} required.`;
                }
            }
        } else if (field.required && missing(value)) {
            empty.push(field);
        }
    }
    if (empty.length) {
        return `${empty.map((field) => field.label).join(", ")} ${empty.length === 1 ? "is" : "are"} required.`;
    }
    return null;
}

/** What a submit sends: the values, each rows field a copy of its rows. */
export function formBody(values) {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
        Array.isArray(value) ? value.map((row) => (row && typeof row === "object" ? { ...row } : row)) : value]));
}
