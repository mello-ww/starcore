# UI contract

StarCore's clients know **UI contracts and capabilities**, not individual Satellites. A
Satellite describes its interface as data, using reusable blocks; Mission Control and the
Android app each render that description with their own platform components. A new Satellite
therefore needs no client update, unless it introduces a genuinely new native capability.

This page is the specification of **UI contract 1.2** (`starcore.ui/1.2`), not released yet.
Each minor only adds to the one before: every 1.0 document is a valid 1.1 and 1.2 document,
and keeps working on clients that know only 1.0. What arrived in 1.1 and 1.2 is marked
where it is described. It covers what is implemented today and what is still the target. The closed vocabulary itself is
machine-readable in [`contracts/ui/vocabulary.json`](../contracts/ui/vocabulary.json).

- [Three ways a Satellite gets an interface](#three-ways-a-satellite-gets-an-interface)
- [Two kinds of capability](#two-kinds-of-capability)
- [The document](#the-document)
- [Blocks](#blocks)
- [Media: image and media-list](#media-image-and-media-list)
- [Media gallery: media-grid](#media-gallery-media-grid)
- [Search and map](#search-and-map)
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
| **UI document** | `ui.json` | shared renderer (`mission_control/ui/renderer.js`) | shared renderer (`SatelliteUiScreen`) | contract 1.2 - the default for new Satellites |
| **Mission Control page** | `mission_control/page.js` | the Satellite's own ES module | - | kept: a trusted, first-party extension for the web |
| **Mobile screen (v0)** | a `mobile` route | - | `DeclarativeScreen`, four item types | kept for compatibility; superseded by `ui.json` |

A validated `ui.json` comes first on both clients. A Satellite that also ships `page.js` keeps
it as the web's fallback, used when its document is missing or refused, and in Developer
Mode Mission Control can show either: the button beside the Satellite's title switches
between the shared interface and the Satellite's own page, so a migration can be compared
side by side before the old page is retired. Status is the first Satellite to make that
move (1.1). Photo follows in 1.2: its document was a **preview** (see
[The document](#the-document)) until it reached parity, and is now its default interface, with
its own page and screens kept in Developer Mode until they are retired. Music keeps its
dedicated, hand-written page and screens until the shared blocks reach parity with them, and
File Explorer its `page.js` (see [Migration](#migration)). Those
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
| `preview` | 1.2, optional `true`: the document doesn't replace the Satellite's own interface yet. A client that has one (a `page.js` on the web, a screen of its own in the app) keeps opening it and offers the document in Developer Mode; a client without one opens the document. The listing reports it as `ui.preview`. Without it, the document is the default and Developer Mode offers the Satellite's own interface instead, on both clients. |
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
- `template` (1.1): `stack` (the default) or `dashboard`;
- `offline` (1.2): `true` lets the client keep the page's data - and the pages a `media-grid`
  on it loaded after that - to show while StarCore can't be reached. Its `source` may depend on
  `$state` only where a `choice` on the page sets it (a few fixed values, one kept collection
  each), never on a search's text. See [Offline pages](#offline-pages).

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
| `image` (1.2) | `src` | `alt`, `caption`, `size`, `shape`, `fit` | an image from one of the Satellite's own routes - see [Media](#media-image-and-media-list) |
| `media-list` (1.2) | `items`, `item` | `empty`, `action`, `size`, `shape` | rows with a thumbnail; `item` maps `title`, `subtitle`, `meta`, `image` and `format` (`{subtitle, meta}`) - see [Media](#media-image-and-media-list) |
| `media-grid` (1.2) | `items`, `item` | `empty`, `action` or `viewer`, `selection`, `size`, `shape` | a grid of images and videos with the shared viewer and selection - see [Media gallery](#media-gallery-media-grid) |
| `search` (1.2) | `key` | `label`, `placeholder` | a search field that sets the page state `key` as the person types - see [Search and map](#search-and-map) |
| `map` (1.2) | `items`, `item` | `empty`, `action` or `viewer` | located items on an interactive map, in clusters, opening the shared viewer - see [Search and map](#search-and-map) |

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

## Media: image and media-list

Both arrived in 1.2. They show images from the Satellite's **own** routes, so any Satellite can
use them without the client knowing what the images are.

```json
{"type": "image", "src": "covers/{$.id}?size=600", "alt": "$.title", "caption": "$.title", "size": "large"}
{"type": "media-list", "items": "$.entries", "size": "medium",
 "item": {"title": "$.title", "subtitle": "$.added", "meta": "$.size", "image": "thumbs/{$.id}",
          "format": {"subtitle": "relative", "meta": "bytes"}},
 "action": {"navigate": "entry", "params": {"id": "$.id"}}}
```

- **`src`** and a row's **`image`** are route templates with the same rules as an action's
  `route`: relative to the Satellite, every `{binding}` URL-encoded, never another Satellite or
  a Core endpoint. The client loads the image with its own session (the browser's cookie, the
  app's bearer header), so a Satellite needs nothing more than an authenticated route that
  answers with the image.
- **`size`**: `small` (48 px), `medium` (96, the default), `large` (240) or `full` (the
  available width) for an image. For a media-list's thumbnails: `small` (40, the default),
  `medium` (56), `large` (72) or `full` (96).
- **`shape`**: `square` (the default), `round`, or `wide` (16:9). Corners follow StarCore's
  rounded surfaces; `round` is a circle.
- **`fit`** (image only): `cover` (the default) fills the frame, `contain` shows all of it.
- While an image loads, its frame shows a quiet placeholder; it fades in once loaded (no motion
  with reduced motion on). An image that can't be loaded, or a route that isn't the Satellite's
  own, shows the image glyph in its place. Images load lazily on the web.
- A media-list row takes the block's `action`, any action (`navigate`, a route, `play`), with
  the row as `$.`, like a `list`. `meta` is a short piece of text at the end of the row.
- `size`, `shape` and `fit` are fixed words, never bindings, so the layout is known before any
  data arrives.

## Media gallery: media-grid

1.2. A grid of images and videos from the Satellite's own routes, for a photo library, a folder
of pictures, album covers or anything else that is mostly pictures. It knows nothing about the
collection: the document says where each picture comes from and what can be done with it.

```json
{"type": "media-grid", "items": "$.items", "size": "medium", "empty": "No photos yet.",
 "item": {"image": "thumbnails/{$.id}", "key": "$.id", "kind": "$.kind", "duration": "$.seconds",
          "group": "$.month", "title": "$.name", "subtitle": "$.taken", "format": {"subtitle": "date"}},
 "viewer": {"image": "originals/{$.id}", "video": "originals/{$.id}", "title": "$.name", "subtitle": "$.date",
            "fields": [{"label": "Size", "value": "$.bytes", "format": "bytes"}],
            "actions": [{"label": "Favorite", "icon": "heart", "visible": "$.can_favorite",
                         "action": {"route": "favorites", "body": {"id": "$.id"}, "then": "refresh"}}]},
 "selection": {"actions": [{"label": "Delete", "icon": "trash-2", "style": "danger",
                            "action": {"route": "items/{$.id}/delete", "confirm": "Delete them?", "then": "refresh"}}]}}
```

- **`item`**: `image` (required) is the tile's thumbnail, a route template like an `image`'s
  `src`. `key` identifies an item across refreshes (its position otherwise). `kind` is
  `image` or `video` (or a binding to one): a video's tile carries a play badge and its
  `duration` (seconds). Consecutive items with the same `group` (text, or a value formatted by
  `format.group`) sit under one heading. `title` and `subtitle` show under the tile when given.
  `icon` (a name from the shared set, or a binding to one) is drawn in place of the image glyph
  when the item has no image - a folder that holds nothing to show, a lock.
- **Tiles open the `viewer`, or run `action`** (any action, the tile as `$.`), not both.
  When the action depends on the item, **`open`** replaces `action`: up to 4
  `{action, visible}` entries, and a tile runs the first whose `visible` holds (an entry
  without one always does). An entry a client can't run there is skipped - an `own` action
  without the Satellite's own interface - and a tile left with none doesn't open. Photos uses it
  for its albums: the Locked Folder's tile opens Photo's own screens, every other tile its album.

  ```json
  {"type": "media-grid", "items": "$.albums",
   "item": {"image": "thumbnails/{$.cover}", "key": "$.id", "title": "$.title", "icon": "$.icon"},
   "open": [{"visible": "$.locked", "action": {"own": "locked"}},
            {"action": {"navigate": "album", "params": {"id": "$.id"}}}]}
  ```
- **`viewer`**: full screen, over everything. It shows `image` (the tile's own when absent), or
  plays `video` in place for a video, with the client's own player controls; on Android only
  the item on screen has a player. `title`, `subtitle`, up to 12 `fields` (`{label, value,
  format, unit}`, shown under Details, empty ones left out) and up to 8 `actions`
  (`{label, action, icon, style, visible}`) on the item shown. Left and right (arrow keys on
  the web, a swipe on Android and on a touch screen's browser) move between items; Escape or
  Back closes it. A web swipe is one finger, over 40 px and well wider than tall, and a swipe
  that starts on a video stays the player's. After an action's
  `refresh`, the viewer stays on its item, or shows the next one when the item is gone. On
  Android an image pinches to zoom (up to 5x) and, zoomed, pans with one finger; a double tap
  zooms in or back out. The swipe between items waits from the moment a second finger touches
  the image (so a sideways pinch is never taken for a swipe) and while it is zoomed, and an item
  is back to its own size when it leaves the screen. Videos keep their player.
- **`quick`**: up to 2 entries shaped like the viewer's actions, each with an `icon`; a tile
  shows the first whose `visible` holds as a small round button in its corner, apart from
  opening the tile. A `primary` one is drawn active (filled, in the accent), so a pair makes a
  toggle - Photos' heart: "Favorite" while `$.can_favorite`, "Unfavorite" while `$.favorite`.
  On the web it shows on hover or focus, always while active and always on a touch screen; on
  Android always. It hides while selecting and in the media picker; no secure action here.
- **`selection`**: up to 4 `actions`. "Select" (or a long press on Android, or Shift-click on
  the web) starts a selection; the bar shows the count and the actions. An action runs once
  per selected item with that item as `$.`; its `confirm` is asked once, its `then` applies
  once at the end, and a count of failures is shown if any.
- **`size`**: `small`, `medium` (the default), `large`, or `full` (one per row): the width
  a tile aims for. Each client fits as many columns as that width allows (3 on a typical phone
  at `medium`), so the grid follows the screen. **`shape`**: `square` (default), `wide` (16:9)
  or `round`.
- **The person's own size**: `size` is where a grid starts. The person can change it - a pinch
  on Android (two columns up to as many as fit at 48 dp, at most 12), a small, medium and large
  pill beside "Select" on the web - and the client remembers it per server, Satellite and grid
  (its `id`). Only the tiles' width changes: what is loaded, the selection and paging stay, and
  the item at the top of the screen stays there. A `full` grid and the media picker keep their
  size. Nothing reaches the Satellite, and a document needs nothing new for it.
- **Loading**: tiles are revealed 60 at a time; the next 60 come as the end of the grid comes
  near. Thumbnails load lazily (the web) or downsampled (Android), each with the placeholder and
  image glyph of `image`.
- **Paging** (`more`, optional): `{"route": "items?limit=120&cursor={$value}", "cursor": "$.next"}`.
  The page's data holds the first page and, at `cursor`, the provider's cursor for the next
  (null at the end). When the grid nears its end, the client calls `route` with that cursor as
  `$value`; the answer has the same shape as the page data, so `items` and `cursor` read it the
  same way. The provider owns the cursor - the client only passes it back - so a provider can
  page by position, by key or however it likes. The client:
  - loads one page at a time, and drops a page that arrives after the page data changed (a new
    filter, a refresh), so results never mix;
  - never shows an item twice, even if a provider's pages overlap;
  - shows "Loading…" while a page is on its way, and an error with "Try again" when one fails;
  - after a refresh of the same collection (an action's `then: refresh`), reloads as many pages
    as were loaded, so the grid, its scroll position and its selection stay where they were;
  - keeps a selection across pages - an action on the selection runs on every selected item,
    loaded on whichever page - and the viewer moves into the next page past the last item.
  A grid without `more` shows what its page data holds, as before.
- **Many items**: on Android a media-grid that is a page's main content becomes the page's
  own virtualized list: only rows near the screen are mounted, so memory stays flat however
  far the person scrolls (blocks above and below it scroll with it). On the web the grid is
  drawn in chunks of 60 tiles that the browser neither lays out nor paints while off screen;
  tiles already loaded stay in the page.
- Images and videos load with the client's own session, as for `image`. A route outside the
  Satellite loads nothing and shows the image glyph.

## Search and map

Both arrived in 1.2, for a Satellite whose data has text to look through or places to show.

```json
"find": {
  "state": {"q": "", "kind": "all"},
  "source": {"route": "search?q={$state.q}&kind={$state.kind}"},
  "blocks": [
    {"type": "search", "key": "q", "label": "Search", "placeholder": "Names, cameras, dates"},
    {"type": "choice", "key": "kind", "options": [{"value": "all", "label": "All"}, {"value": "video", "label": "Videos"}]},
    {"type": "media-grid", "items": "$.items", "item": {"image": "thumbs/{$.id}", "key": "$.id"}, "viewer": {}}
  ]
}
{"type": "map", "items": "$.items", "empty": "Nothing has a location yet.",
 "item": {"lat": "$.lat", "lon": "$.lon", "key": "$.id", "image": "thumbs/{$.id}", "title": "$.name", "kind": "$.kind"},
 "viewer": {"image": "full/{$.id}", "title": "$.name"}}
```

**`search`** is a search field bound to one of the page's `state` keys, like a `choice`. A
moment (300 ms) after the person stops typing, or at once on Enter, it sets the key to the
trimmed text, and every route templated with `$state.<key>` loads again. The Satellite does
the searching, so it decides what matches, and the results are ordinary blocks (`media-grid`,
`media-list`, `list`). Filters are `choice` blocks on other state keys. The field keeps its
focus, text and caret while the results reload, on both clients.

**`map`** places items on an interactive map:

- `item.lat` and `item.lon` (degrees) are required. An item without a valid pair is left out.
  `key`, `image` (a route template, as for `media-grid`), `title` and `kind` describe a marker.
- Markers group into clusters on a grid about 64 px wide on screen, so thousands of items stay
  a handful of markers, and clusters separate as the map zooms in. A cluster shows its count.
- A marker opens the shared viewer on its items (`viewer`, the same keys as a `media-grid`'s)
  or runs `action` on a single item - not both. On the web a cluster first shows up to 12
  thumbnails in a popup; on Android it opens the viewer on its items.
- The map fits its items when they change, and never asks for the device's location.
- With no located items it shows `empty`.
- **Viewport** (`viewport`, optional): `{"route": "located?bbox={$value.bbox}&zoom={$value.zoom}"}`
  makes the map load what is on screen, a moment after it stops moving: `$value.bbox` is
  `south,west,north,east` and `$value.zoom` the zoom level. The answer has the page data's shape;
  its items may be the provider's own clusters, with `item.count` above 1 and `item.bounds`
  (`[south, west, north, east]`): a cluster shows its count and a tap zooms into its bounds. The
  page data then needs no items, only `bounds` (the block's `bounds` binding) for the map to fit
  first, so a map of any number of items stays a bounded answer. A late answer is dropped, and a
  failed one keeps what is shown with "Try again".
- Each client draws with the map it already had: Mission Control with Leaflet and
  OpenStreetMap tiles (loaded only when a map is shown), the Android app with
  react-native-maps, which needs a Google Maps key in `android/gradle.properties` to draw
  tiles and markers. No new map service or key comes with the block.

## Bindings

Any text, value or action body can be a binding instead of a literal:

| Binding | Resolves to |
|---|---|
| `$.a.b` | `a.b` in the current data: the page's data, or the row inside a list's `item` |
| `$` | the current data itself |
| `$page.a` | the page's data, also from inside a list row |
| `$params.id` | a page param |
| `$value` | a control's new value (toggle, slider, file browser); a grid's cursor in `more.route` |
| `$value.a` | 1.2: `a` inside a value that is an object - a map's `$value.bbox` and `$value.zoom` |
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
- **`pick`** (1.2), with a `route`: the person chooses media through the client's own media
  picker, then the route runs with what was chosen as `$value`.

  ```json
  {"pick": {"capability": "media.gallery", "kinds": ["image"], "multiple": true, "title": "Add pictures"},
   "route": "pins", "body": {"items": "$value"}, "then": "refresh"}
  ```

  - `capability` is the Satellite capability to choose from; `media.gallery` is the only one
    so far. The picker lists from whichever Satellite the catalog says provides it, with the
    client's own session, so the document never names a Satellite.
  - `kinds` (`image`, `video`; both by default) limits what is offered; `multiple` (default
    `false`) allows more than one; `title` heads the picker.
  - `$value` is always a list of **references**, never paths:
    `[{"provider": "Photo", "capability": "media.gallery", "id": "...", "kind": "image"}]`.
    The receiving route decides what it accepts. A reference names the providing Satellite, so
    a route can refuse one from elsewhere, and only a provider can say what an id means.
  - Cancelling runs nothing. `confirm` and `then` work as for any route action.
  - A document that uses it declares
    `"requires": {"client": ["media.picker"], "capabilities": ["media.gallery"]}` if the whole
    interface depends on it. Otherwise a client without a picker, or a server without a
    provider, says so when the action runs.
  - The picker is the shared `media-grid` (thumbnails, groups, paging) with a confirm and a
    cancel: a dialog on the web, a full-screen sheet on Android.

- **`own`** (1.2), on its own: `{"own": "settings"}` opens the Satellite's **own interface** -
  its `page.js` on the web, its native screens in the app - at a section that interface names.
  It is the bridge to what stays native while a Satellite migrates (Photo's settings, phone
  sync, the Locked Folder):
  - The section is a name (lowercase letters, digits and `-`, up to 32) that only the
    Satellite's own interface interprets; shared code passes it through and never names a
    Satellite. An own interface opens its default view for a section it doesn't know.
  - It reaches no route and grants nothing: the own interface keeps every rule it has, such as
    a PIN, a permission or locking again on leaving.
  - A client without an own interface for the Satellite hides a button that opens one, and
    says so as a notice if the action runs from elsewhere (a list row).
  - Back returns to the shared interface: on the web the visit is a browser-history entry of its
    own, and a reload stays on it; in the app the native screen is pushed over the shared one.
  - On the web, a section that is another Satellite hosted by this one (`section_of`, such as
    `#/satellite/Photo/LockedFolder`) always opens the own page, which hosts it, whichever
    interface Developer Mode has chosen.
- **`download`** and **`share`** (1.2): `{"download": "originals/{$.id}", "name": "$.title"}`
  fetches one of the Satellite's own routes with the client's own session, then saves the file
  (download) or hands it to the system share sheet (share), named `name` (else the route's last
  segment), with no path separator, reserved character or leading dot. Mission Control saves
  through the browser's own download, and shares through the Web Share API where the browser
  can share files; the app fetches the file in its own module, then saves it to Downloads
  (Android 10 and later) or opens the share sheet with the file itself. A client that can't do
  one hides its control. Nothing reaches the Satellite but that GET. One file at a time: not in
  a selection or a tile's `quick` actions.
- **`secure`** (1.2), in a media viewer's or selection's `actions` only: runs one protected
  operation on the items shown or selected, behind the **client's own** unlock prompt.

  ```json
  {"secure": {"capability": "media.vault", "operation": "move_in"}, "item": "$.id",
   "confirm": "Move to the Locked Folder? It disappears from Photos.", "then": "refresh"}
  ```

  - **What it may run:** only what the vocabulary's `secure_operations` lists. So far that is
    `media.vault` / `move_in`: never an operation that lists, reads or takes anything out.
  - **Whose items:** `item` binds each item's id. The client sends references to the
    document Satellite's **own** `media.gallery` items, built from the catalog, never from
    document data. The Engine refuses the action in a document whose Satellite doesn't provide
    `media.gallery`, and the receiving Satellite resolves every reference itself (see
    "References are claims" below).
  - **One request for a selection:** the action runs once for all selected items, with one
    prompt, not once per item.
  - **The unlock is the client's:**
    1. The client asks the provider's `status` whether the session is unlocked.
    2. If it isn't, the client shows its own PIN prompt (and biometrics where it has them),
       asking `unlock` for a single-use grant for exactly these items.
    3. It runs the operation with that grant.

    A grant isn't an unlock, so there is nothing to lock again afterwards; the Locked Folder
    explains it under "Moves from a shared interface". The document supplies no prompt, no
    PIN field and no route, and a form can never be where the PIN is typed.
  - **`confirm` and `then`** (`refresh` or `back`) work as for any action. The answer's
    `failed` items are reported, and partial success is never shown as complete.
  - **A client** without a provider for the capability, or without a prompt for it, hides the
    control. Mission Control's runner and prompt are `mission_control/ui/secure.js`. The
    app's runner is `mobile/src/satellites/ui/secure.ts`; its prompt for a capability is a
    native screen the composition root (`src/satellites/builtins.tsx`) registers for one
    provider, and the shared screen never sees the PIN, only the grant it hands back.

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

A page that holds a `media-grid` or a `map` (also inside a `card`) gets the full width on
Mission Control too, with no hint from the document: the grid or map spreads across it while
the page's text, forms and buttons keep the reading width. Android already draws every page
at the screen's width.

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
| `media.gallery` | 1 | `list`: `GET ?kinds=image,video[&limit=N&cursor=C]` -> `{items: [{id, kind, title, duration, group}], next}` (with `limit`, one page and the next cursor; without it, everything); `thumbnail`: `GET /<id>` -> an image; optional `resolve`: `GET /<id>` -> `{id, kind}` for an item that may be acted on now, `404` otherwise | the client's media picker (the `pick` action), which pages through a provider that pages |
| `audio.session` | 1 | `queue`; optional `history`, `radio`, `preferences`, `favorites`, `stream`, `connect` - see [Audio playback](media-audio.md) | none; the audio host uses it beside the same Satellite's `audio.library` |
| `media.vault` | 1 | `status`, `unlock` (`for` asks for a single-use grant for one move), `lock`, `move_in` (`{items: [reference], grant?}`); optional `biometric` - see "Moves from a shared interface" in [the Locked Folder](satellites/locked_folder.md) | none yet; the `secure` action will use it. It has no operation that lists or reads what it holds |

A capability's operations are required unless the vocabulary lists them under
`optional_operations`. An operation the version doesn't define is a problem too, so a typo
never registers a provider that only half works.

File Explorer provides `files.browse`; Music provides `audio.library` and `audio.session`; Photo
provides `media.gallery` - its active library only: never the recycle bin, and never anything
in the Locked Folder. The Locked Folder provides `media.vault` only: somewhere to move media
into, with no way to list or read it. Mission Control's folder picker for `"path"`-typed
settings also uses it, so no generic code names File Explorer any more.

**References are claims.** A reference a client sends (`{provider, capability, id}`, as a pick
returns) is never trusted as sent. A Satellite about to act on one asks the Engine
(`starcore/capabilities.py`, `resolve_references`), which:
- finds the capability's provider in its own registry, never from the reference;
- refuses a reference naming any other provider or capability;
- asks that provider's `resolve` operation, with the caller's own session, whether the id is an
  item that may be acted on now.

A provider without `resolve` can't have its references acted on.

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
- Page data is cached only for a page that asks for it (`offline`, below), and only on Android.
- A cached document stands in for the definition **only while the server is unreachable**,
  marked as such. A 401 or 403 is never answered from the cache: cached definitions are never
  treated as permissions or as a session.

### Offline pages

A page with `"offline": true`, or `"offline": {"omit": ["location", "folder"]}`, is kept by the
Android app, so a person who loses the connection can still browse what they saw. Mission
Control keeps nothing: a browser tab without StarCore has nowhere to load from.

- **What is kept**: only what the page's blocks bind, worked out from the document:
  - every `$.` and `$page.` binding in the page's title and blocks, including inside
    `{placeholders}`;
  - inside a block with `items` (or `rows`), its bindings applied to each item;
  - for each `media-grid`, the same fields of the first 4 pages it loaded after that through
    `more`, with the cursor after the last.

  A path keeps only itself (`$.place.city` keeps `place.city`, not the rest of `place`); a
  field bound as a whole keeps its whole value. Everything else the Satellite answered is
  dropped.
- **What is never kept**:
  - a field named in `omit`, wherever it appears (in the page data, in every item, in every
    grid page, at any depth), even where the page binds it. Offline, a viewer field bound to it
    is simply not shown.
  - a token, a resolved URL or an image. Images come from the platform's own cache when it
    still has them, and show the placeholder otherwise.

  The kept copy is unencrypted app storage, and a phone backup may include it, so **a
  Satellite omits what it wouldn't want on the phone that way**: Photo omits each item's GPS
  `location` and its `folder` on the server.
- **`omit`**: 1 to 32 plain field names. A name an item is keyed by (`key`) or reached with (a
  `{$.id}` in an image or a route) can't be omitted: the Engine refuses the document, since the
  kept page would have nothing to show its items by.
- **Scope**: per server, per session (a one-way fingerprint of the session token), per
  Satellite, and per collection (a page, its `params`, and the value of each `choice` its source
  depends on - Photos' Library keeps one copy per grouping). A page whose source depends on any
  other state (a search's text) is never kept, and the Engine refuses to mark it offline.
- **When it is shown**: only when StarCore can't be reached - never in place of an answer that
  refused the request, and never before a live answer has had its chance. The page shows the
  usual "Offline - showing what StarCore said ..." notice with the age of what is shown, tries
  again every 15 seconds and on coming back to the app, and is live again as soon as StarCore
  answers. A grid's next page while offline shows its usual error with "Try again".
- **When it goes**:
  - every live answer replaces what was kept for its collection;
  - any successful action on the Satellite forgets all of that Satellite's collections, so an
    item that was deleted, moved or renamed can't reappear offline (a page that reloads after
    the action keeps itself again);
  - a Satellite's own screens can forget its collections too (Photo's do when they delete a
    photo or move it into the Locked Folder);
  - a 401 or 403 forgets everything kept for the server;
  - signing in, signing out, and removing a server forget everything kept for that server, and
    an earlier session's leftovers are removed when a page opens;
  - after 7 days a collection is no longer shown, and goes.
- **Limits**: 12 collections per server (the least recently used go first) and 512 KB each; a
  collection too large to keep is not kept at all (an older copy is forgotten with it).
- **Storage**: AsyncStorage, one entry per collection
  (`starcore_ui_offline:v2:<server>:<session>:<satellite>:<collection>`) and an index per server.
  The entry is written before the index lists it. An entry is removed when it can't be read
  (and treated as never kept), when the index doesn't list it (an interrupted write), when it
  comes from another session, or when it is past its age.
- **The first store** (`starcore_ui_offline:v1`, which kept whole page data) is removed when the
  app starts, for every server and session, whether an index lists an entry or not, and tried
  again at the next start if storage refused. The current store never reads it.
- **What it can't do**: a change made elsewhere while this phone is offline (a photo deleted
  from the web, moved into the Locked Folder from another device) is only known once StarCore
  answers again. Until then, for at most 7 days and only in a session that was signed in, the
  phone can still list what it kept. A Satellite whose pages must never be seen offline doesn't
  ask for `offline`.

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
capabilities and the catalog's providers. Both clients claim `media.audio` (the `play` action)
and `media.picker` (the `pick` action); the other reserved names are in `vocabulary.json`. The
`own` action needs no capability: whether a client has a Satellite's own interface is its own
knowledge, so it hides what it can't open.

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
| Blocks | the 21 above, including `chart`, `table`, `image`, `media-list`, `media-grid`, `search` and `map`; the `dashboard` template | more, minor by minor: `tabs`; templates `list-detail`, `settings`, `media-library` |
| Satellite capabilities | `files.browse` (File Explorer), `audio.library` and `audio.session` (Music), `media.gallery` (Photo), `media.vault` (Locked Folder, `move_in` only through the `secure` action) | browsing the Locked Folder from the shared interface; more pickable capabilities (files) |
| Client capabilities | `media.audio` on both clients (the shared audio host, [Audio playback](media-audio.md)), used by the `play` action; `media.picker` (the media picker), used by the `pick` action; each client's own unlock prompt for `media.vault`, used by the `secure` action; saving and sharing files (`download`, `share`) | `device.background-tasks` (phone sync) - a native module written once in the app, behind a shared block |
| Home | `widgets` in each document, drawn by both clients; Android keeps the Status card only for servers older than Status's `ui.json` | the fallback card removed once older servers are gone |
| Sections | `section_of`, but Photo still names the Locked Folder | the host discovers its sections from the catalog |
| Icons | `icon_name` from the shared set; an Android fallback list for older servers | the fallback list removed once older servers are gone |
| Rediscovery | Mission Control button and API | also on Android; and a CLI command |
| Formats | 12, including rates, dates and relative times | |

## Migration

Every step is additive, keeps the Alpha working, and replaces a hand-written screen only
once the shared one reaches parity. Music keeps its dedicated screens until then, and File
Explorer its `page.js` ([its plan](file-explorer-migration.md)); Photos and Status open their
shared interfaces and keep their previous screens in Developer Mode until they are retired.
Retiring all of them is planned in [Retiring Satellite-specific interfaces](legacy-ui-retirement.md).

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
   1. `media.gallery` from Photos' grid and viewer. **Done (1.2):** the shared
      `media-grid` block and viewer, and Photo's `ui.json`, now its default interface on both
      clients (see "Shared interface" in [docs/satellites/photo.md](satellites/photo.md)).
      Photo's own page and screens stay in Developer Mode until they are retired;
   2. `media.vault` from the Locked Folder. **Partly done (1.2):** the `secure` action moves
      photos in from Photos' shared viewer and selection, behind each client's own PIN and
      biometric prompt. Next: the Locked Folder itself in the shared interface;
   3. `audio.library` and `media.audio` from Music's player, queue and downloads, specified in
      [Audio playback](media-audio.md). **Done (1.2):** the shared audio host on both clients
      and the `play` action. Music's own library screens are still native.

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
