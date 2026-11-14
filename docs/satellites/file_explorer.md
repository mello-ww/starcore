# File Explorer

File Explorer browses and manages the files of the machine StarCore runs on: any folder the
StarCore process itself can reach. There is no sandbox or configured root; the operating
system's permissions are the only boundary (`satellites/native/file_explorer/paths.py`). The
Locked Folder's guard still refuses anything inside a locked Locked Folder.

Its interface is described once, in `ui.json` (UI contract 1.2, see
[docs/ui-contract.md](../ui-contract.md)), and drawn by both clients' shared renderers. Since F7
it is File Explorer's only interface on both clients; the migration's history is in
[docs/file-explorer-migration.md](../file-explorer-migration.md).

## What it does

| Where | What |
| --- | --- |
| Locations | every drive (or `/`) with its free space, and the machine's total |
| A folder | its folders then its files, loaded 200 at a time as you scroll; New folder, Rename and Delete (with a confirm) for the folder itself, and **Upload files** |
| A file | its details, a preview for a picture, **Open**, **Download** and **Share**, Rename and Delete |

- **Open** hands the file to the browser (a new tab, sandboxed for HTML, SVG and XML) or to the
  phone's viewer; **Download** saves it; **Share** uses the phone's share sheet.
- **Upload files** picks one or more files on the device and sends them one after another. A
  file that already exists is replaced only once the person confirms; each file is reported
  ("Uploaded 2 of 3 files. Kept the existing notes.txt."). Files up to 2 GB; a file is written
  under a `.part` name and renamed once complete, so a failed upload leaves nothing behind.
- Errors are shown as notices, never as an empty page.

## How it works

```
satellites/native/file_explorer/
    api.py                  the routes: entries, content, upload, mkdir, rename, delete, view
    views.py                the read-only `view/...` routes ui.json binds to
    paths.py                path resolution and safety
    locked_folder_guard.py  refuses a locked Locked Folder's contents
    ui.json                 the interface, for every client (UI contract 1.2)
    mission_control/icon.svg  its icon (no page of its own: the interface is ui.json)
```

It provides the `files.browse` capability (`list` → `entries`), which any interface's
file-browser block and Mission Control's folder picker use without naming this Satellite.

## Previous web page

File Explorer's own Mission Control page (`page.js`, `page.css`, with its four storage themes) was
retired in F7: the web and the Android app draw the same `ui.json`, and the shared `metric` bars
show the storage. The migration's history is in `docs/file-explorer-migration.md`.

## Tests

`engine/tests/test_file_explorer.py` (routes), `engine/tests/test_file_explorer_ui.py` (the
document and its view routes), `mission_control/tests/files.test.mjs` and `upload.test.mjs`,
and the app's `mobile/__tests__/fileExplorerUiDocument.test.tsx` and `fileUpload.test.ts`.
