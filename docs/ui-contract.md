# UI contract

StarCore's clients know **UI contracts and capabilities**, not individual Satellites. A
Satellite describes its interface as data, using reusable blocks; Mission Control and the
Android app each render that description with their own platform components. A new Satellite
therefore needs no client update, unless it introduces a genuinely new native capability.

This page is the specification of **UI contract 1.1** (`starcore.ui/1.1`). 1.1 only adds to
1.0: every 1.0 document is a valid 1.1 document, and keeps working on clients that know only
1.0. It covers what is implemented today and what is still the target. The closed vocabulary itself is
machine-readable in [`contracts/ui/vocabulary.json`](../contracts/ui/vocabulary.json).

- [Three ways a Satellite gets an interface](#three-ways-a-satellite-gets-an-interface)
- [Two kinds of capability](#two-kinds-of-capability)
- [The document](#the-document)
- [Blocks](#blocks)
- [Bindings](#bindings)
- [Actions](#actions)
- [Formats](#formats)
- [Dashboards, headers and widgets](#dashboards-headers-and-widgets)
- [Shared blocks and Satellite capabilities](#shared-blocks-and-satellite-capabilities)
- [Discovery, caching and rediscovery](#discovery-caching-and-rediscovery)
- [Versions and negotiation](#versions-and-negotiation)
- [Trust and validation](#trust-and-validation)
- [Conformance tests](#conformance-tests)
- [Current implementation and target](#current-implementation-and-target)
- [Migration](#migration)

## Three ways a Satellite gets an interface

| Mechanism | File | Web | Android | Status |
|---|---|---|---|---|
| **UI document** | `ui.json` | shared renderer (`mission_control/ui/renderer.js`) | shared renderer (`SatelliteUiScreen`) | contract 1.1 - the default for new Satellites |
| **Mission Control page** | `mission_control/page.js` | the Satellite's own ES module | - | kept: a trusted, first-party extension for the web |
| **Mobile screen (v0)** | a `mobile` route | - | `DeclarativeScreen`, four item types | kept for compatibility; superseded by `ui.json` |

A validated `ui.json` comes first on both clients. A Satellite that also ships `page.js` keeps
it as the web's fallback, used when its document is missing or refused, and in Developer
Mode Mission Control can show either: the button beside the Satellite's title switches
between the shared interface and the Satellite's own page, so a migration can be compared
side by side before the old page is retired. Status is the first Satellite to make that
move (1.1). Music and Photo keep their dedicated, hand-written screens on both clients until
the shared blocks reach parity with them (see [Migration](#migration)). Those
implementations are the behavioural reference for the capabilities still to come, not code
to be thrown away.

## Two kinds of capability

**Client capabilities** are what a client can do on its device beyond drawing blocks: native
audio playback, biometric prompts, background tasks, a screen that can't be captured. They
belong to Mission Control or the Android app, and only a client update adds one.

**Satellite capabilities** are services one Satellite provides to the others through the
Engine: listing files, a media library, an audio stream. A Satellite declares them in its
manifest (`provides`), the Engine keeps the registry (`GET /api/catalog`), and any interface
can use one without knowing which Satellite provides it.

A shared block joins the two. The `file-browser` block, for example, is drawn by each client
(client side) and browses through whichever Satellite provides `files.browse` (Satellite
side). Every Satellite can embed it - a future StarCore AI Satellite could offer a file
picker without depending on File Explorer.

## The document

A Satellite ships `ui.json` beside its `satellite.toml`. It is a static file: the live data
comes from the Satellite's ordinary routes, through bindings.

```json
{
  "contract": "starcore.ui/1.0",
  "title": "Notes",
  "requires": {"client": [], "capabilities": ["files.browse"]},
  "entry": "home",
  "navigation": [
    {"page": "home", "label": "Notes", "icon": "file-text"},
    {"page": "settings", "label": "Settings", "icon": "settings"}
  ],
  "pages": {
    "home": {
      "source": {"route": "notes", "refresh": 30},
      "blocks": [
        {"type": "list", "items": "$.notes", "empty": "No notes yet.",
         "item": {"title": "$.title", "subtitle": "$.updated"},
         "action": {"navigate": "note", "params": {"id": "$.id"}}}
      ]
    },
    "note": {
      "title": "$.title",
      "params": ["id"],
      "source": {"route": "notes/{$params.id}"},
      "blocks": [{"type": "text", "text": "$.body"}]
    },
    "settings": {"blocks": []}
  }
}
```

| Key | Meaning |
|---|---|
| `contract` | `starcore.ui/<major>.<minor>` - required. See [Versions](#versions-and-negotiation). |
| `title` | Optional display name; clients fall back to the Satellite's name. |
| `requires` | Optional. `client`: client capabilities the whole interface needs; `capabilities`: Satellite capabilities it needs. A client that can't meet them shows why instead of the interface. |
| `entry` | The page that opens first. It can't require params. |
| `navigation` | Optional top-level pages: tabs on both clients. Each names a `page`, a `label`, an optional `icon` from the shared set and, from 1.1, `developer: true` for a page shown only in Developer Mode. |
| `header` | 1.1, optional: blocks shown above the navigation on every top-level page, with a `source` of their own - see [Dashboards, headers and widgets](#dashboards-headers-and-widgets). |
| `widgets` | 1.1, optional: up to 4 summaries a client may show outside the Satellite (Home). |
| `pages` | Page id (lower case, digits, `-`, `_`) to page. |

A **page** has `blocks` and optionally:

- `title`: text or a binding, shown on detail pages;
- `params`: the names it must be opened with;
- `source`: `{route, refresh}`, the Satellite route (a template, see [Actions](#actions))
  whose JSON response is the page's data, refetched every `refresh` seconds (at least 2) while
  the page is visible;
- `sources` (1.1): up to 4 more, `{name: {route, refresh}}`, each loaded and refreshed on its
  own and bound as `$sources.<name>`. They are supplementary: one that fails leaves its blocks
  empty and the page standing;
- `state` (1.1): the page's own values, `{key: default}` - what a `choice` selects - bound as
  `$state.<key>`. Route templates may use them, so a choice can change what the page loads;
- `template` (1.1): `stack` (the default) or `dashboard`.

While a page is visible, its sources refresh on their own; a hidden browser tab or an app in
the background polls nothing. When a refresh fails, the page keeps what it last showed,
dimmed, under a notice saying since when; when the first one fails, it says so with a way
to try again.

Pages listed in `navigation` (and the entry page) are top-level. Any other page is a detail
page, which clients open on top with a way back. On Android, that is a pushed screen.

Keys starting with `_` are comments and are ignored.

## Blocks

| Block | Required | Optional | What it is |
|---|---|---|---|
| `heading` | `text` | | a section heading |
| `text` | `text` | `style`: `body`, `caption`, `mono` | a paragraph |
| `field` | `label`, `value` | `format`, `unit`, `tone` | a label and its value |
| `metric` | `label`, `value` | `format`, `unit`, `max`, `tone` | a prominent value, with a bar when `max` is set |
| `card` | `blocks` | `title` | a group of blocks (nested at most 4 deep) |
| `list` | `items`, `item` | `empty`, `action` | rows from an array; `item` maps `title`, `subtitle`, `value`, `icon` and `format` (`{subtitle, value}`) for each one |
| `button` | `label`, `action` | `style`: `primary`, `secondary`, `danger` | runs an action |
| `toggle` | `label`, `value`, `action` | `description` | an on/off switch; the action gets the new value as `$value` |
| `slider` | `label`, `value`, `min`, `max`, `action` | `step`, `format`, `unit` | a range; the action runs once, on release, with `$value` |
| `form` | `fields`, `submit` | | inputs (`text`, `number`, `select`, `toggle`) and a submit action that gets them as `$form` |
| `file-browser` | `capability` | `select`: `none`, `directory`, `file`; `action`; `label` | the shared file browser - see [Shared blocks](#shared-blocks-and-satellite-capabilities) |
| `chart` (1.1) | `series` | `title`, `kind`: `columns` (default) or `bars`, `format`, `unit`, `max`, `from`, `to`, `resolution`, `empty` | a time series - see below |
| `table` (1.1) | `rows`, `columns` | `empty` | rows from an array, one cell per column - see below |
| `choice` (1.1) | `key`, `options` | `label` | a segmented control that sets the page state `key`; `options` are `[{value, label}]`, at most 8 |
| `status` (1.1) | `label` | `tone`, `detail` | a state as a dot and a word, never colour alone ("Healthy", "2 warnings") |
| `code` (1.1) | `value` | `label`, `copy` | text or JSON, folded under `label`, with a Copy button when `copy` is true |

1.1 also adds:

- to `field` and `metric`: `detail`, a line under the value;
- to `metric`: `trend` (points, drawn as a sparkline) and `action` (the metric opens something:
  a dashboard tile you can press);
- to a `list`'s `item`: `tone`, drawn as a state dot;
- the text style `eyebrow`, a small upper-case label.

A `metric`'s bar carries severity, not identity: it is neutral until its `tone` is `warn` or
`danger`, so a bar never looks critical just because the accent is red.

A **chart**'s `series` is a list of up to 4 `{label, points}`. `points` binds to an array of
`[time, value]` or `[time, value, peak]` (epoch seconds), the shape a history route returns.
`from`, `to` and `resolution` (seconds per point) place them on a time axis: a stretch with no
points is drawn as a gap, never bridged. `format` and `unit` format the values, `max` fixes the
top of the axis (otherwise one is rounded up from the values, in the format's own steps), and
`empty` is what an empty chart says. Every chart offers its values as a table too. A `bars`
chart draws one series of plain numbers (`[12, 40, 7]`) against `max`, such as per-core usage.

A **table**'s `columns` are up to 10 `{label, value, format, unit, align, tone, max}`, where
`value`, `tone` and `max` bind inside each row (`$.` is the row). `align` is `start` or `end`.
A column with a `tone` shows a state dot beside its value; one with a `max` shows a bar. Mission
Control draws a table; the Android app draws each row as a small card - the first column as
its title, the others as labelled values - because a phone is one column wide.

Every block may also have:

- `id`;
- `visible`: a binding; the block shows only when it's truthy, meaning not `null`, `false`, `0`,
  `""` or an empty list;
- `developer: true`: shown only in Developer Mode, which is a display preference, never a
  permission;
- `required: true`: see [Versions](#versions-and-negotiation).

`tone` is `neutral`, `ok`, `warn` or `danger`, or a binding to one. `icon` names come from
the shared icon set in `vocabulary.json` (Feather glyph names), which both clients draw
natively.

There is deliberately no layout language: no arbitrary nesting, styles, colours or sizes.
Blocks look like the rest of StarCore on each platform because each client draws them.

## Bindings

Any text, value or action body can be a binding instead of a literal:

| Binding | Resolves to |
|---|---|
| `$.a.b` | `a.b` in the current data: the page's data, or the row inside a list's `item` |
| `$` | the current data itself |
| `$page.a` | the page's data, also from inside a list row |
| `$params.id` | a page param |
| `$value` | a control's new value (toggle, slider, file browser) |
| `$form.key` | a form field, inside its submit action |
| `$state.key` | 1.1: the page's own state (see `state` above) |
| `$sources.name.a` | 1.1: `a` in a named source's data |
| `$$text` | the literal string `$text` |

Numeric segments index arrays: `$.rows.0.id`. A missing value resolves to `null`, which
displays as "—". **There is no expression language**: no operators, conditions or string
building. A Satellite returns what it wants shown. For example, Showcase returns both
`enabled` and `disabled` so that one block can be `visible` for each.

## Actions

```json
{"route": "items/{$params.id}/delete", "method": "POST", "confirm": "Delete this item?", "then": "back"}
{"route": "settings", "body": {"level": "$value"}, "then": "refresh"}
{"navigate": "item", "params": {"id": "$.id"}}
```

- **`route`** is a template: each `{binding}` is replaced by its URL-encoded value, so a value
  can never add a path segment. The result is always relative to the Satellite's own
  `/api/satellites/<name>/`, and must stay there:
  - no leading `/`, scheme, `..`, `.` or empty segment;
  - none of the Core's own segments (`assets`, `enable`, `disable`, `reload`, `ui`);
  - only URL-safe characters.

  A document can't reach another Satellite or a Core endpoint such as shutdown.
- **`method`** is `POST` (the default, with `body` as JSON) or `GET`.
- **`body`** can contain bindings; a form's submit action without a `body` sends the form's
  values.
- **`confirm`** asks first: a native dialog on Android, the browser's own on the web.
- **`then`** says what happens after a successful request:
  - `refresh` reloads the page data;
  - `back` closes a detail page;
  - `{navigate, params}` opens a page, where `$.` refers to the action's **response**, which is
    how "add an item, then open it" works.
- **`navigate`** on its own is a navigation-only action.
- **`play`** (1.2), on its own: `{"play": {"search": "$.query"}}` asks the client to play what
  the catalog's `audio.library` provider finds for `search` (text or a binding), through the
  client's own audio host. It reaches no route, so it can't reach anything the provider doesn't
  already offer. A document that uses it declares
  `"requires": {"client": ["media.audio"], "capabilities": ["audio.library"]}`: a client without
  an audio host, or a server without an audio library, then says so instead of opening it. When
  nothing is found, the client says so as a notice. See [Audio playback](media-audio.md).

A response may carry `{"message": "..."}`, shown as a short notice; an error response's
`error` is shown the same way. Either way, the page then shows what is actually true again.

## Formats

| Format | Input | Example |
|---|---|---|
| `text` (default) | anything | `true` → "Yes"; `3.14159` → "3.14"; `null` → "—" |
| `number` | number | `1234.5678` → "1234.57" (no thousands separator) |
| `integer` | number | `7.6` → "8" |
| `percent` | 0 to 100 | `7.34` → "7.3%" |
| `bytes` | bytes, powers of 1024 | `1536` → "1.5 KB" |
| `duration` | seconds | `303` → "5m 3s"; `90000` → "1d 1h" |
| `bitrate` (1.1) | bytes per second, shown in bits | `1880` → "15 kb/s"; `1562500` → "12.5 Mb/s" |
| `byterate` (1.1) | bytes per second | `1536` → "1.5 KB/s" |
| `time` (1.1) | epoch seconds, in the device's time zone | "17:15" |
| `date` (1.1) | epoch seconds | "4 Nov 2026" |
| `datetime` (1.1) | epoch seconds | "4 Nov 2026, 17:15" |
| `relative` (1.1) | epoch seconds | "just now", "42s ago", "5 min ago", "2 h ago", "2 d ago", "in 2 min" |

`unit` is appended after a space: `21.5` with `"unit": "°C"` → "21.5 °C". A non-numeric value
under a numeric format falls back to `text`. Dates and times are written the same way on every
client, whatever its language settings, so the fixtures can test them.

The Engine formats exactly like the clients (`format_value` in `engine/starcore/ui_contract.py`,
checked against the same fixtures), so a Satellite can build a line out of several values -
"8 GB of 16 GB" - that reads like the values the clients format themselves.

## Dashboards, headers and widgets

These are the 1.1 additions that let a Satellite like Status describe a whole monitoring
interface without client code of its own.

**`template: "dashboard"`** lays a page out for reading at a glance. On Mission Control, a run
of `metric` blocks becomes a grid of tiles, a run of charts sits two to a row and so do plain
cards (one holding a table takes the full width); runs of `field` blocks inside a card
become a grid of facts. The page uses the full width. On Android, metrics become two-column
tiles and everything else stacks. It is a layout hint, not a layout language: a document still
cannot place, size or colour anything.

**`header`** is a band above the navigation on every top-level page: `{source, blocks}`. Its
source is loaded once for all the pages and refreshed on its own. Mission Control puts its
`status` blocks on the right; both clients show a `field` there as one line of context.

**`widgets`** are summaries any client may show outside the Satellite's own pages, such as
Home:

```json
"widgets": [{
  "id": "health", "title": "Status", "icon": "activity",
  "action": {"navigate": "overview"},
  "blocks": [
    {"type": "status", "label": "$.health_label", "tone": "$.health_tone"},
    {"type": "metric", "label": "CPU", "value": "$.cpu_percent", "format": "percent", "max": 100}
  ]
}]
```

A widget without a `source` binds to the state the Satellite already publishes (its `state.py`,
returned with every `GET /api/satellites`), so a client draws it from the listing it already
has, with no request of its own. One with a `source` is loaded by the client that shows it.
A widget's only action is to open one of the Satellite's pages. Widgets suit short summaries
(status, metrics, fields, text, a few list rows). Home shows each enabled Satellite's widgets
in place of the per-Satellite cards it used to hardcode.

## Shared blocks and Satellite capabilities

A Satellite declares the capabilities it provides in its `satellite.toml`:

```toml
[provides."files.browse"]
version = 1
operations = { list = "entries" }
```

Each operation maps to one of the Satellite's own routes. The Engine checks the declaration
at load time: a capability the vocabulary knows must offer every operation of a protocol
version the Engine knows. A capability with any problem is left out with a warning, so a client
never binds to a half-declared provider. A Satellite may also declare a capability that isn't in
the vocabulary yet. It is registered as declared, ready for a future shared block.

`GET /api/catalog` lists the providers of each capability. Clients use the **first enabled
provider** speaking a version they know. If there is none, a block bound to that capability
says so in place, and a document that `requires` it is not opened.

| Capability | Version | Operations | Shared block |
|---|---|---|---|
| `files.browse` | 1 | `list`: `GET ?path=` → `{path, parent, entries: [{name, type: dir\|file, size, modified}]}`; at the roots (`path` empty) each entry's name is itself an absolute path | `file-browser` |
| `audio.library` | 1 | `search`, `track`, `resolve`, `artwork`; optional `lyrics` - see [Audio playback](media-audio.md) | none yet; the `media.audio` client capability will play it |
| `audio.session` | 1 | `queue`; optional `history`, `radio`, `preferences`, `favorites`, `stream`, `connect` - see [Audio playback](media-audio.md) | none; the audio host uses it beside the same Satellite's `audio.library` |

A capability's operations are required unless the vocabulary lists them under
`optional_operations`. An operation the version doesn't define is a problem too, so a typo
never registers a provider that only half works.

File Explorer provides `files.browse`; Music provides `audio.library` and `audio.session`. Mission Control's folder picker for `"path"`-typed
settings also uses it, so no generic code names File Explorer any more.

A capability is a long-term protocol. It is designed from what an existing Satellite already
does, not speculatively, and a new version is added beside the old one.

## Discovery, caching and rediscovery

```
GET  /api/satellites                 each entry: icon_name, provides, ui {contract, revision, error};
                                     plus catalog_revision for the whole set
GET  /api/satellites/<name>/ui       {satellite, revision, document}; ETag = revision; 304 on If-None-Match
GET  /api/catalog                    {contract, revision, capabilities, pending}; ETag; 304
POST /api/catalog/rediscover         re-read metadata from disk (see below)
```

**Revisions** are content hashes:

- `ui.revision` hashes the document;
- `catalog_revision` hashes what every Satellite *is*: names, versions, pages, routes, icons,
  capabilities, UI revisions and whether each is enabled. Live state and status are not
  included.

A client that sees the same revision knows its cached copy is current.

**Caching** is per server and per contract major:

- Android keeps documents in AsyncStorage (`starcore_ui_doc:v1:<server>:<satellite>`). A copy of
  the exact revision `GET /api/satellites` reported opens without a request; anything else is
  revalidated with `If-None-Match`.
- Mission Control relies on the browser's HTTP cache. The Engine sends `Cache-Control:
  no-cache` with an ETag, so the browser always asks, and an unchanged document costs a 304.
  Mission Control's own files and Satellite assets now work the same way instead of
  `no-store`.
- Page data is never cached.
- A cached document stands in for the definition **only while the server is unreachable**,
  marked as such. A 401 or 403 is never answered from the cache: cached definitions are never
  treated as permissions or as a session.

**Rediscovery** is the **Rediscover** button on Mission Control's Satellites page, and
`POST /api/catalog/rediscover`. It refreshes metadata from disk without touching code:

- For each loaded Satellite, it re-reads `ui.json` and the presentational parts of
  `satellite.toml` (`icon_name`, `provides`). These are plain files, read and validated, never
  imported.
- A new Satellite folder is reported as **pending**: loading it means importing its Python,
  which only happens at the next restart. There is no unsafe hot-loading.
- A loaded Satellite whose name or version changed on disk is reported as **reload
  required**. Its code has changed too, so only the existing per-Satellite **reload** or a
  restart applies it.
- A Satellite whose folder disappeared is reported as **missing** and keeps running until
  StarCore restarts.

A Satellite's reload (an explicit, per-Satellite action that does re-import its code) also
re-reads its `ui.json`. On Android, returning to the Satellites tab picks up new revisions;
there is no Rediscover button there yet.

## Versions and negotiation

The contract is `starcore.ui/<major>.<minor>`:

- **Major** changes break compatibility. A client only renders majors it knows, and shows a
  document for any other major as needing an update. The Engine refuses it at load time.
- **Minor** changes only add: new blocks, keys and formats. A document may declare a newer
  minor than a client knows. That client skips the blocks it doesn't recognise, unless a block
  says `"required": true`, in which case it shows "needs a newer app" in its place.
- The Engine checks strictly for its own minor: an unknown block or key is a typo, refused
  with a reason. A newer minor is checked leniently.
- A document must declare the minor it uses: a `starcore.ui/1.0` document that uses a 1.1 block,
  key, format or binding (or a 1.1 document that uses the 1.2 `play` action) is refused
  ("needs starcore.ui/1.1"), so a client that knows only 1.0
  is never handed one it would draw half of. `vocabulary.json` lists what arrived in each minor
  (`since`).

`GET /api/catalog` reports what the Engine supports (`contract.version`, `majors`, and the
capability protocol versions). Clients check a document's `requires` against their own client
capabilities and the catalog's providers. No 1.x block uses a client capability, so neither
client claims any yet; the reserved names are in `vocabulary.json`.

An app released with 1.0 (the Alpha) that meets a 1.1 document draws its 1.0 blocks and skips
the rest. Status keeps that case simple: the Alpha app opens Status's own dedicated screen,
which reads the routes it always did.

## Trust and validation

**A document is presentation only and grants nothing.**

- Every route it names is an ordinary Satellite route, behind the same authentication as any
  other. A route enforces its own rules even when the document hides the control; Showcase's
  counter refuses an increment while disabled, whatever the client shows.
- The Engine validates every document at load and rediscovery: structure, vocabulary,
  bindings, route templates, limits (256 KB, 32 pages, 200 blocks per page, nesting depth 4,
  refresh of at least 2 s; from 1.1, 4 sources per page, 4 widgets, 4 series per chart, 10
  columns per table, 8 options per choice). A `$state` or `$sources` binding must name what
  its page declares. A refused document is reported in the Satellite's `ui.error` and never
  served.
- Clients check again, because a client can't assume every server validated what it sends:
  - they render only known blocks;
  - they call only safe, relative routes;
  - they show all text as plain text, never HTML;
  - they load icons from their own set;
  - they execute nothing.
- Satellite code is Python with full rights on the server, so the trust decision is
  **installing** a Satellite. A declarative interface keeps a careless one from going further
  in the browser: unlike `page.js`, it can't script Mission Control with the user's session.

## Conformance tests

Both renderers implement the same rules, and these tests keep them in step:

| Implementation | Module | Test |
|---|---|---|
| Engine | `engine/starcore/ui_contract.py` | `engine/tests/test_ui_contract.py` |
| Mission Control | `mission_control/ui/contract.js` | `node --test contracts/ui/tests/web.test.mjs` |
| Android | `mobile/src/satellites/ui/contract.ts` | `mobile/__tests__/uiContract.test.ts` |

All three read `contracts/ui/vocabulary.json` and the fixtures in `contracts/ui/fixtures/`
(bindings, route templates, route safety, formats, valid and invalid documents). A change to
the contract starts there. Formats with times take `options` (`utc`, `now`) in the fixtures,
so every implementation is tested against the same moment in the same time zone.

Status's document is tested on every side too: the Engine checks it validates and that every
route it names exists (`engine/tests/test_status.py`), and the app renders it with its
`view` data (`mobile/__tests__/statusUiDocument.test.tsx`).

`engine/tests/test_client_modularity.py` fails when generic client code names a Satellite.
The couplings that predate 1.0 are listed with their counts, and that list may only shrink.

The example Satellite **Showcase** (`examples/satellites/native/showcase/`) uses every block,
navigation, detail pages, a form, a slider and the shared file browser. It lives outside
`satellites/` so it is never loaded on a real install. To try it, copy the folder into
`satellites/native/` and restart StarCore.

## Current implementation and target

| | Now (contract 1.2) | Target |
|---|---|---|
| Blocks | the 16 above, including `chart` and `table`; the `dashboard` template | more, minor by minor: `image`, `map`, `tabs`; templates `list-detail`, `settings`, `media-gallery`, `media-library` |
| Satellite capabilities | `files.browse`, `audio.library`, `audio.session` | `media.gallery` (Photos), `vault` (Locked Folder) |
| Client capabilities | `media.audio` on both clients (the shared audio host, [Audio playback](media-audio.md)), used by the `play` action | `secure.screen`, `device.biometrics`, `device.background-tasks` - each a native module written once in the app, behind a shared block |
| Home | `widgets` in each document, drawn by both clients; Android keeps the Status card only for servers older than Status's `ui.json` | the fallback card removed once older servers are gone |
| Sections | `section_of`, but Photo still names the Locked Folder | the host discovers its sections from the catalog |
| Icons | `icon_name` from the shared set; an Android fallback list for older servers | the fallback list removed once older servers are gone |
| Rediscovery | Mission Control button and API | also on Android; and a CLI command |
| Formats | 12, including rates, dates and relative times | |

## Migration

Every step is additive, keeps the Alpha working, and replaces a hand-written screen only
once the shared one reaches parity. Music, Photos and Status keep their dedicated screens
until then.

1. **Done:** document v0 (the `mobile` route and `page.js`); the modularity guard.
2. **Done:** Engine metadata: `icon_name`, `provides`, `ui.json` with revisions and ETags,
   `catalog_revision`, `/api/catalog`, rediscovery, revalidating static files.
3. **Done:** contract 1.0 and both renderers, proven by Showcase.
4. **Partly done:** remove cheap couplings.
   - Done: icons come from `icon_name`; the folder picker uses `files.browse`; Home draws
     widgets instead of naming Status.
   - Next: sections discovered instead of Photo naming the Locked Folder.
5. Rediscovery and cache controls on Android.
6. **Done (1.1): Status first.** `chart`, `table`, `choice`, `status`, `code`, the
   `dashboard` template, page state and sources, the header and widgets. Status's `ui.json`
   now draws its interface on both clients. Its `page.js` and `StatusHomeScreen` stay for one
   release: the web's fallback and Developer Mode comparison, and the app's screen for older
   servers. Then they are retired (see "Status's migration" in
   [docs/satellites/status.md](satellites/status.md)).
7. **Capabilities, one at a time, extracted from the existing code:**
   1. `media.gallery` from Photos' grid and viewer;
   2. `vault` with `secure.screen` and `device.biometrics` from the Locked Folder;
   3. `audio.library` and `media.audio` from Music's player, queue and downloads. Specified
      first in [Audio playback](media-audio.md), with its own milestones, because the
      player is the largest piece of Satellite-specific client code.

   Each becomes a shared block or module that any Satellite can use, and removes one name check
   from the clients.
8. Retire v0: deprecate the `mobile` route once nothing uses it. `page.js` stays as the web
   extension mechanism.

Backward compatibility:

- An Alpha (0.1.0-alpha.1) Android app talking to a newer server ignores the new fields: it
  shows a Satellite that has only `ui.json` as having no mobile interface yet, and still opens
  everything it opened before.
- A newer app talking to an Alpha server finds no `ui` fields and no `/api/catalog`, and
  behaves like the Alpha app.
