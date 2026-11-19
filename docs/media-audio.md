# Audio playback: `media.audio` and `audio.library`

Status: **implemented** on both clients (milestones 1 to 5 below): `audio.library` and
`audio.session` v1 are in `contracts/ui/vocabulary.json`, Music provides them, and each
client's AudioHost (`mission_control/media/`, `mobile/src/media/`) plays through them. Music's
library screens are still its own; their move to `ui.json` is planned in the last section,
"Music on the shared interface". See [UI contract](ui-contract.md), "Two kinds of capability",
for the general model.

Playback is split in two, along the line the UI contract already draws:

| | `media.audio` | `audio.library` |
|---|---|---|
| Kind | client capability | Satellite capability |
| Who implements it | Mission Control and the Android app, once each (the **AudioHost**) | any Satellite with audio (Music today) |
| What it is | playing a queue: transport, state, lifecycle, native integration, and the shared player UI | the content: search, stream resolution, artwork, optional lyrics |
| Found through | the client itself (`requires.client`) | the capability catalog, `GET /api/catalog` |

A client never names the Satellite that provides audio. It plays tracks it got from an
`audio.library` provider, resolved through the catalog, and any Satellite (a future StarCore AI,
say) can start playback or offer a track picker without depending on Music.

`media.audio` replaced the reserved, never-implemented client capability name
`media.audio-playback` in `contracts/ui/vocabulary.json`. Nothing read or claimed the old
name (not the Engine, either client or the released Alpha app), so the rename broke no
document.

## `audio.library` - the Satellite side

Declared in `satellite.toml` like `files.browse`. Each operation maps to one of the
provider's own routes; Music's existing routes already have these shapes, so **Music adds the
declaration and no new route**.

```toml
[provides."audio.library"]
version = 1
operations = { search = "search", track = "tracks", resolve = "playback", artwork = "artwork", lyrics = "lyrics" }
```

| Operation | Required | Request → answer | Music's route |
|---|---|---|---|
| `search` | yes | `GET ?q=&limit=` → `{tracks: [Track], albums?, artists?, playlists?}` | `GET search` |
| `track` | yes | `GET /<id>` → `{track: Track}` | `GET tracks/<id>` |
| `resolve` | yes | `GET /<id>?quality=&format=` → `{track, plan, stream, gain}`; `stream` is a path relative to the provider, answering `Range` | `GET playback/<id>` |
| `artwork` | yes | `GET /<album>?size=` → an image | `GET artwork/<album>` |
| `lyrics` | no | `GET /<id>?language=` → synced lines or plain text | `GET lyrics/<id>` |

`Track` is the subset every host needs: `{id, title, artist, album, album_id, duration,
has_artwork, quality: {label, lossless, hires}}`. A provider may return more; hosts ignore
the rest.

Not part of `audio.library` v1, because they are a library's own features rather than
playback: favourites, playlists, history, stats, recommendations, scanning. They stay on the
provider's own routes and in its own interface. They are added to the protocol only when a
second provider or consumer needs them (a new version beside v1, as the contract requires).

### `audio.session` - the playback session beside a library

What a host does around playback, beyond the library itself, uses a second capability,
`audio.session` v1, in the shared vocabulary. A host uses it only from the **same** Satellite
as its `audio.library` provider, and only a version it knows. The Engine checks a declaration
like any other: `queue` is required, the rest are optional, and an operation v1 doesn't
define, a malformed route or an unknown version leaves the whole capability out.

`queue` is the one required operation because it is what makes a session. It lets a listener
pick up where they left off on another device, and Connect transfers resolve their tracks
through it. Without an optional operation, its feature is simply absent: a request for it is
never sent, likes and preferences stay unchanged, and Connect and the full player's Devices
tab aren't offered.

| Operation | Required | Used for | Music's route |
|---|---|---|---|
| `queue` | yes | the server copy of the queue (`GET ?device=&expand=1`, `POST {device, state, name, kind}`), and resolving tracks for a Connect transfer | `queue` |
| `history` | no | reporting plays (`POST {track_id, seconds, device, context}`) | `history` |
| `radio` | no | continuing when the queue ends ("autoplay"): `GET /<kind>/<id>` → `{tracks}` | `radio` |
| `preferences` | no | streaming and download quality, effects, speed: `GET`, `POST {key: value}` | `preferences` |
| `favorites` | no | the like button: `GET` → `{ids: {track}}`, `POST {kind, ids, liked}` | `favorites` |
| `stream` | no | a stream (`GET /<id>?quality=&format=`, with `Range`) when the resolve step can't plan one | `stream` |
| `connect` | no | StarCore Connect under this route: `register`, `state`, `events`, `command`, `transfer`, `devices` | `connect` |

## `media.audio` - the client side (the AudioHost)

Each client has one AudioHost, mounted by the shell rather than by a Satellite's page, so
playback survives navigation and is available to any interface.

### Queue and transport

The behavioural reference is `player/player.js` (web) and `mobile/src/music/player.ts` plus
`queue.ts` (Android).

- A queue of entries `{provider, track: Track, context?}`. `provider` is the catalog id, so
  mixed queues from several providers work.
- Controls: play, pause, toggle, seek, next, previous, shuffle (a shuffle order kept beside
  the queue), repeat `off | all | one`, volume and mute, a sleep timer (minutes or end of
  track), play next, add to queue, and clear upcoming.
- State and events: `track`, `state` (`playing`, `position`, `duration`, `buffering`,
  `error`), `queue`, `sleep`, `blocked` (the web: audio needs a tap first), and `remote` (see
  Connect below).
- Streams come from the provider's `resolve` with the listener's quality preference. Gapless
  playback and crossfade follow the existing engine behaviour (`audio/engine.js`; Android's
  player).

### Lifecycle and native integration

| Concern | Web (reference) | Android (reference) |
|---|---|---|
| Background playback | the tab keeps playing; hidden tabs pause only UI work | the `mediaPlayback` foreground service from react-native-video/Media3 (`AndroidManifest.xml`) |
| System controls | Media Session metadata and actions (`player.js`, `updateMediaSession`) | the media notification and lock screen through the same service |
| Audio focus | the browser's | Media3's: pause on loss, duck on transient loss |
| Autoplay | `blocked` state with a "Tap to resume here" chip (`bar.js`) | none needed |
| Persistence | the queue on the server (`GET/POST queue?device=`) | `starcore_player_queue:<server>` locally, plus the server queue |

### Effects

Effects are optional. Each one reports `{applied, reason}` and never fails playback:
equalizer, bass boost, loudness, ReplayGain, normalisation, speed and pitch.
- **Web:** Web Audio (`audio/effects.js`).
- **Android:** `StarCoreAudioModule.kt`, in the Kotlin package `com.starcore.mobile.media`.

### Connect

StarCore Connect (moving playback between a listener's devices) stays a Music feature, because
the relay is Music's server routes (`connect/*`). The AudioHost exposes one integration point:
- a **remote target**, which takes the transport commands and reports `remote` state, plus a
  way to export and import the queue for a transfer.

Music's `connect.js` and `mobile/src/music/connect.ts` become that target's implementation.
Hosts show "Playing on <device>" and route controls to it without knowing Connect exists.

### Offline downloads

Downloads are an Android client feature (`StarCoreDownloadsModule.kt`,
`starcore_music_downloads:<server>`, in the app-private `files/music/` folder: both keep their
first name, because renaming either would orphan the copies already on a phone). A resolved
local file wins over the stream. A document
that depends on them declares `requires.client: ["media.audio"]` and checks its own features.

## The shared player UI

The AudioHost owns the player UI, so every audio Satellite gets the same one. The current
implementation is the specification. Visual language: floating rounded surfaces, pill
controls, the global accent for active states, restrained motion.

| Element | Behaviour to keep | Web reference | Android reference |
|---|---|---|---|
| Floating bar | a rounded bubble clear of the edges, drawn over content (no backing rectangle); cover, title, artist, like, transport, seek; the cover opens the full player | `bar.js`, `styles/player.css` (`.pl-bar`) | `MiniPlayer.tsx`, mounted over the screens in `MainTabs.tsx` |
| Retract | a chevron (and a swipe down on Android) puts the bar away; the choice is remembered | `starcore.player.collapsed` | `starcore_player_collapsed` (`dock.ts`) |
| Top-bar disc | the playing cover as a disc, spinning while playing, with an accent ring while the bar is open; tap toggles the bar | `#topbar-extras` slot (`index.html`) | `TopBarSlot` in every header |
| Transition | the cover flies between the disc and the bar, between measured positions; skipped when reduced motion is on | Web Animations in `bar.js` | `MusicFlight`, `dock.ts` anchors |
| Scroll space | screens keep their last row clear of the bar, using the bar's measured height, only while it shows | `body.pl-has-bar` padding | `FloatingPlayerInset` / `FloatingPlayerSpacer` |
| Full player | artwork, lyrics, queue, devices and info as pill tabs | `fullscreen.js` | `FullPlayer.tsx` |

The full player's lyrics tab appears when the track's provider offers `lyrics`, and the devices
tab when a remote target is registered. Info shows what the resolved `plan` reports.

## Compatibility

Backward compatibility is not required for now (StarCore runs only on the owner's server, on the
latest version); the host no longer assumes a provider on a server without the capability.

- Music's REST routes stay as they are: Music's own page and screens use them directly.
- Persisted state is the player's own: `starcore.player.*` (web) and `starcore_player_*`
  (Android). They replaced `starcore.music.*` and `starcore_music_*` on 2026-11-13, without a
  migration: the saved queue and the Connect device id were reset once. Only the offline
  downloads keep their first names (above).
- Until a client implements `media.audio`, Music keeps its current players. A host that does
  implement it takes over the same keys and the same UI, so the switch is invisible.

## Migration plan and acceptance criteria

The milestones are in order; each is shippable on its own.

### 1. This specification - done

### 2. Contract groundwork - done

- Add `audio.library` v1 to `satellite_capabilities` in `contracts/ui/vocabulary.json`.
- Rename the reserved `media.audio-playback` to `media.audio`.
- Music declares `[provides."audio.library"]`.

Accepted when:
- `GET /api/catalog` lists Music as the `audio.library` provider.
- The Engine's manifest check accepts the declaration and rejects one missing a required
  operation.
- The engine tests pass, and no Music route changes.

### 3. Android AudioHost - done

What it is now:
- `mobile/src/media/` holds the host: `AudioHost.tsx` (the player, downloads, Connect and
  the native output), `library.ts` (provider resolution and requests), the controller and
  queue, and the player UI under `media/ui/`.
- `MainTabs.tsx` mounts it. Music's screens and its additions to the player (the track menu,
  links to its album and artist screens) come in through one composition root,
  `mobile/src/satellites/builtins.tsx`. With no `audio.library` provider in the catalog, the
  host has nothing to play from.
- Music's screens still reach Music's own routes (`music/api.ts`). They are Music's code.
- `builtins.tsx` is temporary. It exists so Music's native screens keep working while they
  have no `ui.json`. Each entry goes once Music's declarative interface replaces that screen,
  and the file goes with the last one; its line in `KNOWN_IMPORTS`
  (`engine/tests/test_client_modularity.py`) is lowered at each step.

Follow-ups found while building it:
- **Formalize `audio.session`** - done: v1 is in the shared vocabulary (see above).
- **Lock-screen position after a pause** - done. The 0:00 seen on the emulator was the end
  of the queue (its demo tracks last seconds), where the player goes back to the start; a
  pause from the lock screen keeps its position. What it did show: the lock screen, the
  notification and a headset drive the native player directly, and the app kept believing
  it played. The AudioHost now passes the native playing state on (`onNativePlaying`), which
  takes a stop as a pause only when the native player then reports it is still ready
  (`onNativeReady`: Media3 reports a stop before the end or the loading that explains it),
  never one while loading, seeking or at a track's end.
- **Timers with the screen locked** - done. React Native suspends its JS timers while the
  activity is paused (a locked screen included), so the sleep timer, the stream's retry and
  the deferred queue saves (which publish a resume made from the lock screen) waited for the
  app to return. The AudioHost hands the player native one-shot timers (`backgroundTimers` in
  `src/media/native.ts`, the `StarCoreTimer` module on the main looper); native events and
  prop changes already reach the player in the background. Its timers use the uptime clock,
  so they also wait while the phone is in deep sleep, which playback prevents.
- **Naming left from Music** in both hosts (a type, test IDs, labels, the web's keyboard
  shortcuts tied to Music's page): listed under "Leftovers the guard can't see" in
  [Remaining work](remaining-work.md).

Accepted when:
- `MainTabs.tsx` imports nothing from `src/music/`.
- No shared file names Music; the modularity guard also catches `../music/` imports in
  shared code.
- Playback, the queue (restored across launches), shuffle and repeat, sleep, effects,
  downloads and Connect behave as before.
- The bubble has no backing rectangle; the disc sits in every header; the flight animates
  between measured positions; scroll space is reserved only while the bar shows.
- Background playback, the notification, lock-screen controls and audio focus are checked
  on a physical device as well as the emulator.
- The existing Music tests pass unchanged, plus tests for catalog resolution.

### 4. Web AudioHost - done

What it is now:
- `mission_control/media/` holds the host: `host.js` (started by the shell after sign-in),
  `library.js` (provider resolution and requests by operation), `session.js` (preferences,
  likes, notices and the event bus), the controller, audio engine and effects, Connect, the
  bar, seek, full screen, queue, devices, lyrics, keys, and `media.css` (the `--pl-*` tokens,
  shared pieces and the player's styles, loaded on every page).
- Music's page keeps its library views. It shares the host's event bus. Its preferences and
  likes are the host's session when the host plays from Music, and its own routes otherwise.
  It registers what it adds to the player with `setExtensions` (`/media/extensions.js`): its
  track menu, Add to playlist, and links to its album, artist and library views.
- Until a Satellite's page has registered them, the player offers less: no Add to playlist,
  the title and artist are plain text, and More is hidden. Lyrics and Devices appear only when
  the provider offers `lyrics` and the session `connect`.
- No fallback for older servers is needed on the web: Mission Control is served by the same
  Engine, so it always has the catalog.
- Tests: `node --test mission_control/tests/media.test.mjs` (a provider the client doesn't
  know, found only through the catalog; missing operations) and the modularity guard (the
  host imports only its own folder).

Accepted when:
- The bar and disc appear on any page once something plays, including after a reload before
  Music's page is opened. This fixes today's gap.
- Media Session controls, the autoplay tap, the effects, Connect and the collapsed state
  (`starcore.player.collapsed`) behave as before.
- The shell names no Satellite, and Music's page works with the host.

### 5. A second consumer - done

A Satellite can play from `audio.library` without naming or importing its provider, on both
clients, with no client code of its own:
- Its `ui.json` (contract 1.2) carries the UI contract's `play` action on any button or list
  row: `{"play": {"search": "$.search"}}`.
- The client's shared renderer hands the search to its audio host (`playSearch` on both
  clients), which runs the catalog provider's `search` operation and plays what it finds through
  the same floating player, disc and queue as any other playback.
- The document `requires` client `media.audio` and capability `audio.library`; both clients
  claim `media.audio` and know `audio.library` v1.
- `play` was the one contract addition this needed (contract 1.2): actions could only reach the
  Satellite's own routes or navigate.

The Engine tests build such a consumer in a temporary folder (`PlayActionConsumerTest` in
`engine/tests/test_ui_contract.py`); the repository ships no example of it. A `track-picker`
block (the counterpart of `file-browser`) is still not designed: nothing needs one yet.

### Risks

- Background behaviour differs by Android version and vendor: test on real hardware.
- Browsers block audio without a gesture: keep the `blocked` state.
- Connect transfers carry the queue format: keep the format unchanged across the move.

## Music on the shared interface: audit and plan (2026-11-18, at 24bb300)

Stage 5 (R4) of [Remaining work](remaining-work.md). Music is the last Satellite with an
interface of its own. Its player is already the shared audio host (milestones 3 to 5 above);
what is left is its library: every view and screen below, then their removal. Compared from
the code, not the docs:

- **Own web (OW):** `satellites/native/music/mission_control/page.js`, its `views/` (home,
  search, library, album, artist, playlist, collections, settings, stats), `ui/` (track lists,
  cards, menus, Add to playlist), `store.js` and `router.js`, and what it registers with
  `setExtensions` (`mission_control/media/extensions.js`).
- **Own Android (OA):** `mobile/src/music/` (`MusicHomeScreen` with the Home, Search and Library
  tabs, Album, Artist, Playlist, TrackList, Settings, Equalizer, Downloads, the `TrackActions`
  sheet and its playlist picker), wired by `mobile/src/satellites/builtins.tsx` (8 screens and
  `MUSIC_AUDIO_EXTENSIONS`) and by `DEDICATED_SCREENS` in `mobile/src/screens/HomeScreen.tsx`.
- **Contract (UI 1.2):** what the shared renderers (`mission_control/ui/`,
  `mobile/src/satellites/ui/`) can draw today, as specified in [UI contract](ui-contract.md).
- **Server:** Music's routes (`routes_catalog.py`, `routes_listener.py`, `routes_playback.py`,
  `discovery.py`), which already answer most pages' data.

Legend, as in [the Photos audit](photos-parity-audit.md):
- **Marks:** ✅ = yes, ◐ = partly or different, ✗ = no; n/a = not on that platform.
- **Fix types:** C*n* = contract change *n* (below); S = a Music server change; J = Music's
  `ui.json` only; H = a host or renderer change with no contract change; N = accepted as a
  difference.
- **Priority:** P0 = needed before the shared interface becomes Music's default; P1 = should
  be there before the own interface is removed; P2 = optional.

### Parity matrix

| # | Feature | OW | OA | 1.2 today | Gap | Fix | Pri |
|---|---|---|---|---|---|---|---|
| 1 | Navigation: Home, Search, Your Library, Stats, Settings | ✅ sidebar | ◐ Home, Search, Library pills and a Settings button | ✅ `navigation` tabs | None: five tabs on both clients. | J | P0 |
| 2 | Home: greeting, empty-library state with "Open settings", the "built only from your library" hint | ✅ | ◐ no empty state | ✅ `heading`, `text`, `button`, `visible` | The greeting's hour becomes the server's (the own pages send the device's). | J+S; N for the hour | P0 |
| 3 | Home shelves: Continue listening (albums, playlists, artists and mixes mixed), Made for you (Daily Mixes), Your listening, top albums and artists, Recently added, Genre mixes, Moods, Start listening | ✅ horizontal shelves | ✅ `Shelf` | ◐ a `media-grid` wraps onto rows | A shelf is one row that scrolls sideways. The sections are a fixed set the server orders (`discovery.py`), so the document lists them, each `visible` when present; a mixed shelf opens each tile by kind through `open`. | C7, J+S | P0 |
| 4 | Home track sections: Recently played, Recommended (each song's reason), Liked songs with "Show all" | ✅ | ✅ | ◐ `media-list` rows | No like, menu or playing mark on a row; a row can't play its list from itself. | C6, C7 | P0 |
| 5 | Playing a list: a row plays its list from that row; Play and Shuffle on an album, playlist, mix or artist; the play's context reported to history | ✅ | ✅ | ✗ `play` takes only a search | The core gap: the document can't hand the host the tracks it shows. | C6 | P0 |
| 6 | Album page: cover, title, artist link, year and type, totals, Play, Shuffle, Save, Radio, tracks by disc and number, credits, More by the artist | ✅ | ◐ no credits | ◐ `image`, `heading`, `field`, `button`, `media-list` | Play, Shuffle and Radio need C6; More by the artist is a shelf (C7). | C6, C7, J | P0 |
| 7 | Artist page: picture, Play, Shuffle, Follow, Radio, top songs, Albums, Singles and EPs | ✅ | ✅ | ◐ | As #6. | C6, C7, J | P0 |
| 8 | Mix, radio, mood and genre pages (generated lists, each song's reason) | ✅ one view | ✅ `TrackListScreen` | ◐ | A mix's or playlist's cover is a mosaic the clients draw. | S: one cover route composing the mosaic; C6, J | P0 |
| 9 | Your Library: Playlists (by folder, pinned first), Liked Songs, Albums, Artists, Recently played, Folders, Genres | ✅ seven tabs | ◐ Playlists, Albums, Artists, plus Liked, Recent and Downloads rows | ◐ no tab strip inside a page | One `choice` for the tab; the server answers only the selected tab's key, so each block shows by `visible`. | J+S: `library?tab=&q=&sort=` | P0 |
| 10 | Library filter field and sorting (albums by added, released, quality, name, and release type; artists all, featured, followed) | ✅ client-side | ◐ filter and A-Z | ✅ `search`, `choice` (8 options at most) | Filtering moves to the server. The playlists' folder filter becomes groups. | S, J | P0 |
| 11 | Long lists: thousands of albums or liked songs | ◐ progressive DOM | ◐ FlatList | ◐ a `media-grid` and a `list` page; a `media-list` doesn't | A `media-list` needs `more`, and on Android the virtualized page (F2b). | C7 | P0 |
| 12 | Folders tab: a library root, then its folders and tracks | ✅ | ✗ | ✅ `breadcrumb`, `list`, `media-list` | – | J+S | P1 |
| 13 | Search as you type: Top result, Songs, Albums, Artists, Playlists, Genres, All songs; a quality filter | ✅ | ◐ no genres | ✅ `search`, `choice`, sections with `visible` | – | J+S | P0 |
| 14 | Search: recent searches (with Clear) and Browse genres while the field is empty | ✅ | ◐ recent only | ✅ blocks `visible` on an empty query | Recording a search: the own pages record on Enter or on a pick, which the shared field has neither of. | S: record the query with the result the person opens; or drop it | P2 |
| 15 | Search: suggestions while typing; a genre filter | ✅ | ◐ suggestions | ✗ no completion; a `choice` can't list dynamic genres | Results already follow the text after 300 ms. | N | P2 |
| 16 | Track row: like heart, quality badge (Lossless, Hi-Res), album link, duration, an unavailable file dimmed, the playing mark | ✅ | ◐ no album link | ◐ `title`, `subtitle`, `meta` only | The heart and the playing mark need C7; the badge and "Unavailable" go in the row's text. | C7, S (`liked` per row) | P0 |
| 17 | Track menu on a row: Play next, Add to queue, Add to playlist, Like, Start radio, Go to album, Go to artist, Credits and file info, Remove from this playlist, Download | ✅ menu, right-click, Shift+F10 | ✅ sheet, long press | ✗ a row has one action | A row needs a menu of actions; Play next and Add to queue need C6's `queue`. | C6, C7 | P0 |
| 18 | Card menu on an album: Play, Play next, Add to queue, Add to playlist, Save, Pin, Radio, Go to artist; a Play button on hover | ✅ | ✗ | ◐ `quick` (2 icons), no menu | A tile menu is the row menu on a `media-grid`. | C7 | P1 |
| 19 | Add to playlist: choose a playlist (or New playlist), then "already in this playlist" with Skip or Add anyway | ✅ dialog | ✅ sheet | ✗ `pick` chooses media from a capability only | A generic "choose one of the Satellite's items, then run a route", with a conflict step like `upload`'s. | C8 | P0 |
| 20 | Playlists: create, rename, description, folder, delete, a cover image or the automatic mosaic | ✅ | ◐ create, rename, delete | ✅ forms, `confirm`, `upload` | – | J+S (a cover from the raw body) | P0 |
| 21 | Playlist: reorder (drag on the web, arrows on Android), remove a song | ✅ | ✅ | ✗ no reorder | A list whose rows the person moves, each move one request. | C8 | P0 |
| 22 | Smart playlists: rules (field, operator, value), match all or any, order, limit, Preview | ✅ | ✗ | ◐ form `rows`; a form shows no preview | Preview becomes the playlist page itself, after saving. | J+S | P1 |
| 23 | M3U import (listing the unmatched entries) and M3U8 export | ✅ | ✗ | ✅ `upload`, `download` | Import takes JSON today. | S (`playlists/import` from the raw body), J | P1 |
| 24 | Pins: pin an album or a playlist; pinned first | ✅ | ◐ shows pins | ✅ a menu entry (C7), the server's order | – | C7, J | P2 |
| 25 | Web sidebar: Liked Songs and every playlist, always visible | ✅ | n/a | ✗ | Your Library's Playlists tab replaces it. | N | P2 |
| 26 | Settings, playback: streaming quality (Wi-Fi, cellular), transcode format, ReplayGain, normalise, crossfade, gapless, speed, pitch, keep pitch, when the queue ends | ✅ | ◐ | ✅ `form`, `toggle`, `slider` (on release) | The host keeps the session's preferences; a change from a page must reach it at once. | C9 (`reloads`), J | P0 |
| 27 | Equalizer: on, preset, ten bands, preamp, bass boost | ✅ vertical sliders, live | ✅ steps | ◐ ten `slider`s | A slider applies on release, not while dragging; no vertical layout. | N, J | P1 |
| 28 | Appearance: theme, accent (StarCore's, from the artwork, a custom colour), density, visualizer, lyrics offset | ✅ | ✗ | ◐ no colour field | The custom colour is a `#rrggbb` text field the server checks. | J+S | P2 |
| 29 | Privacy: history, recommendations, scrobbling (disabled), Clear history | ✅ | ✅ | ✅ | – | J | P0 |
| 30 | Devices: the listener's devices, Forget one | ✅ | ✗ (the player's Devices tab) | ◐ the forget route takes the asking device's id | The session is enough to forget a device of one's own. | S, J | P2 |
| 31 | The library on the server: summary tiles, its settings (library folders as a list, patterns, transcoding), the Developer Mode ones | ✅ | ✗ | ✅ `metric`, form `rows`, `developer` | – | J+S | P1 |
| 32 | Scan: Scan now, progress while running, Cancel; Find duplicates | ✅ | ✗ | ✅ a page refreshing every 2 s, `button`, `visible` | – | J | P1 |
| 33 | Stats: a range (7, 30, 90, 365 days, all), minutes, plays, songs, library tiles; top songs, artists, albums, genres; plays by hour | ✅ | ✗ | ✅ `dashboard`, `metric`, `media-list`, `chart` (`bars`) | – | J+S | P1 |
| 34 | Wrapped: a year, its personality, tiles, top songs, artists, genres, artists discovered, Play your top songs, the previous and next years | ✅ | ✗ | ◐ | Play needs C6; the years come as the answer's `previous` and `next`. | C6, J+S | P1 |
| 35 | Credits and file info (tags, file, format) | ✅ dialog | ✗ | ✅ a `track` detail page of `field`s | The resolved stream's plan stays in the full player's Info tab. | J | P1 |
| 36 | Offline downloads: an album or a playlist, a song from its menu, Remove download, a downloaded mark | n/a | ✅ | ✗ | Keeping a provider's tracks on the device is the client's: the document names tracks, the client owns the storage and the control's state. | C10 | P0 (Android) |
| 37 | Downloads page: jobs and progress, kept songs with size and quality, removal; download quality, network, storage limit | n/a | ✅ | ✗ | A screen of the client's own, like the phone sync's. | C10 | P0 (Android) |
| 38 | The player's track menu (More in the full player) | ✅ registered | ✅ `TrackMenu` | ✗ only from a page's own code | The provider's document declares it. | C9 | P0 |
| 39 | The player's title and artist links, Add to playlist, Open library | ✅ registered | ◐ album and artist | ✗ | As #38. | C9 | P0 |
| 40 | A like in the player shows on the page, and the reverse | ✅ shared store | ✅ shared context | ✗ page data is a snapshot | A page follows the session's likes and preferences. | C9 (`follows`) | P1 |
| 41 | Web keyboard shortcuts: Space, Shift+arrows, arrows, M, L, Q, `/` | ◐ only on Music's page (`.pl-root`) | n/a | – | Active wherever the host plays; `/` focuses the page's `search` block. | H | P1 |
| 42 | Offline browsing (Android) | n/a | ✗ | ✅ `offline` pages | Shared is ahead: Home, Your Library and album pages can be kept. | J | P2 |

The shared interface is ahead in places: Android gains stats, Wrapped, smart playlists, M3U,
the Folders and Genres tabs, the library's settings, scan and duplicates; both clients gain the
server-side filter, which no longer loads a whole library into a page; Android gains offline
pages.

### Contract changes

Five changes, numbered after the five of Photos and the Locked Folder. Each is generic (any
Satellite with audio, or with a list, can use it) and lands in one milestone, together in the
Engine's validation (`engine/starcore/ui_contract.py`), `contracts/ui/vocabulary.json`, the
fixtures in `contracts/ui/fixtures/`, both renderers, every `ui.json` it affects,
[UI contract](ui-contract.md) and this file.

**Change 6 - `play` with tracks.** **Done (A1).** `play` took `{"search": ...}` only. Added:

```json
{"play": {"tracks": "$page.tracks", "start": "$.id", "context": "$page.context"}}
{"play": {"route": "radio/track/{$.id}"}}
{"play": {"tracks": "$.tracks", "shuffle": true}}
{"play": {"tracks": ["$"], "queue": "next"}}
```

- `tracks` binds a list of `Track` objects in the page data (a row's own, `["$"]`, for one;
  at most 50 single bindings);
  `route` instead GETs one of the Satellite's own routes whose answer has `tracks`. Exactly one
  of `search`, `tracks` and `route`.
- `start` is the id of the first track to play (the first by default); `shuffle` shuffles;
  `queue` is `next` or `end` (Play next, Add to queue) instead of replacing the queue.
- `context` (text or a binding, at most 80 characters) is what the host reports with each
  play (`audio.session`'s `history`), as the own pages do (`album:<id>`, `mix:<id>`). Bindings
  build no strings, so Music's answers carry it: `context` on an album, an artist, a mix, a
  radio station, a mood and a genre. With `route` and no `context`, the answer's own is used.
- With `tracks` or `route`, the provider is **the document's own Satellite**, which must provide
  `audio.library` (checked at load, as for `sync`). The host plays those ids through that
  provider's `resolve`, never a stream URL from the document.
- Allowed in a row's or a tile's `menu` and `quick` (change 7); not in a selection (nor, until
  change 7, in a tile's `quick`).
- **A2**, with Liked Songs and Your Library: a long list is never sent whole. With `route` the answer may be paged (`tracks` with a
  `cursor`): the host queues the first page and asks for the next when about 25 tracks are
  left. With `shuffle`, the host keeps only the list's size and draws positions lazily (a
  partial Fisher-Yates over the indexes, about 100 ahead, refilled 50 at a time), so
  Shuffle on 10,000 liked songs costs one page, not the whole list. The `route` answers a
  `count` and pages by position for that.

**Change 7 - shelves and track rows.**

- `media-grid` gets `layout: "row"`: one row that scrolls sideways (a shelf), at the grid's
  `size`, with no paging, density control or selection. Android draws a horizontal list, the
  web a scroll-snapping row with Previous and Next buttons.
- `media-list` gets what a `media-grid` already has, so a list of tracks needs no client code:
  `key`; `more` (paging, the list's rule, and on Android the virtualized page); `group`
  (headings, as the grid's); `quick` (up to 2 icon actions at the row's end, a pair being a
  toggle: the heart).
- `menu` on a `media-list` row and on a `media-grid` tile: up to 10 `{label, icon, action,
  visible, style}`, with the row as `$.`. The web opens it from a More button, a right-click,
  the context-menu key or Shift+F10; Android from a More button or a long press, as a sheet.
  An entry the client can't run is left out (including one that needs the server while the
  client is offline, such as Start radio, a like or Add to playlist), and an empty menu hides its button.
- `item.audio` (a binding to a track id) marks a row as one of the document's own
  `audio.library` provider's tracks: the client marks the one playing (the equaliser bars),
  and with change 10 a kept one.

**Change 8 - choosing and reordering.**

- `choose`, with a `route`: the person picks one of the Satellite's own items in a client
  dialog (the web) or sheet (Android), then the route runs with it as `$value`.

  ```json
  {"choose": {"source": "playlists?editable=1", "items": "$.playlists",
              "item": {"title": "$.name", "subtitle": "$.summary", "image": "covers/playlist/{$.id}"},
              "title": "Add to playlist",
              "create": {"label": "New playlist", "field": "Name", "route": "playlists",
                         "body": {"name": "$value", "tracks": ["$.id"]}}},
   "route": "playlists/{$value.id}/add", "body": {"tracks": ["$.id"]},
   "conflict": {"confirm": "$answer.message", "route": "playlists/{$value.id}/add",
                "body": {"tracks": ["$.id"], "allow_duplicates": true}},
   "then": "refresh"}
  ```

  `source` is one of the Satellite's routes, its rows drawn as a `media-list`'s; `create`
  offers one text field and runs its own route instead. A `409` asks `conflict.confirm` (text,
  or the answer's `message`), then runs `conflict.route`; declining stops there. Cancelling
  runs nothing. It is the counterpart of `pick`, which chooses media from a capability's
  provider.
- `reorder` on a `media-list` with a `key`: `{"route": "playlists/{$params.id}/move",
  "body": {"entry": "$.entry_id", "to": "$value.to"}}`. The web drags a row by its handle (and
  moves the focused row with Alt+Up and Alt+Down); Android drags after a long press on the
  handle. Each drop is one request: the list moves at once, and is put back with the route's
  error if it fails. Not with `more` (the whole list must be loaded) or `group`.

**Change 9 - the document and the audio host.**

- A document key `audio`, read by a client's audio host **from the document of the Satellite it
  plays from**:

  ```json
  "audio": {
    "menu": [
      {"label": "Add to playlist", "icon": "list", "action": {"choose": "..."}},
      {"label": "Start radio", "icon": "radio", "action": {"play": {"route": "radio/track/{$.id}"}}},
      {"label": "Go to album", "icon": "disc", "visible": "$.album_id", "action": {"navigate": "album", "params": {"id": "$.album_id"}}},
      {"label": "Credits and file info", "icon": "info", "action": {"navigate": "track", "params": {"id": "$.id"}}}
    ],
    "album": {"navigate": "album", "params": {"id": "$.album_id"}},
    "artist": {"navigate": "artist", "params": {"id": "$.artist_id"}},
    "library": {"label": "Open Music", "action": {"navigate": "home"}}
  }
  ```

  `$.` is the playing track as the provider's `track` operation answers it. The full player's
  More shows `menu` after the host's own entries; the title and the artist open `album` and
  `artist`; `library` is the host's way to the provider's pages. A `navigate` opens that
  Satellite's shared page from wherever the player is. Without `audio`, the host offers what it
  offers today on a page that registered nothing. This replaces `setExtensions` on the web and
  `AudioHostExtensions` on Android.
- `reloads` on a route action: `"reloads": "audio.session"`. Once it succeeded, the client
  reloads what it keeps from that capability of the document's own Satellite (the host's
  preferences and likes), so a setting or a heart changed on a page reaches the player at once.
  The vocabulary lists which capabilities can be named.
- `follows` on a page: `"follows": ["audio.session"]`. The page's sources load again when the
  client changes that state itself (a like in the player, a preference from the full player).

**Change 10 - keeping tracks on the device.** A client capability `media.audio-offline`, on
Android only (a browser keeps nothing).

- The action `{"offline": {"tracks": "$.tracks"}}` (or `route`, or `["$"]`, as in change 6)
  keeps those tracks of the document's own `audio.library` provider on the device, at the
  listener's download quality, network rule and storage limit (the session's preferences).
  The control's label and state are the client's: Download, Downloading 3 of 12, Downloaded
  with Remove download. The document supplies no path, URL or storage setting.
- `sync_capabilities` gains `audio.library` → `media.audio-offline`, so
  `{"sync": {"capability": "audio.library"}}` opens the client's own Downloads screen (jobs,
  progress, kept songs, sizes, removal) for the document's own provider.
- A kept track is marked on a row with `item.audio` (change 7). The host already plays a kept
  file before the stream.
- A client without it (Mission Control) hides the control and the link.

### Server changes (S)

Music's routes already answer most pages. What changes, all inside Music's folder:

- `home` keyed by section id (`continue`, `recent`, `mixes`, ...), so the document places each
  section; each item says how it opens (`kind`).
- `library?tab=&q=&sort=&type=&cursor=&limit=`: only the selected tab's list, filtered and
  sorted on the server, paged where long; playlists with their `folder` as a group.
- `liked` on every track, album and artist row the listener sees; a row's summary line
  (`"12 songs · 48 min"`) and its quality badge (Lossless, Hi-Res) as text.
- One cover route for a playlist, a mix or a mood (its mosaic composed on the server, cached).
- `playlists/import` and `playlists/<id>/cover` from a raw body (the `upload` action);
  `playlists/<id>/add` answering `409` with a `message` and the duplicates.
- `wrapped?year=` with `previous` and `next`; `connect/forget` with the session alone; the
  accent's custom colour checked as `#rrggbb`.
- Each change keeps the own pages working until A10 (they read the same routes), or is made
  beside the route they use.

### Milestones

Music's `ui.json` starts with `"preview": true`: its own page and screens stay the default, and
Developer Mode opens the document, until A9 makes it the default. One commit per milestone,
each tested on both clients (automated tests, the web and the emulator) and summarised to the
owner.

| # | Milestone | Matrix | Contract | Model and effort |
|---|---|---|---|---|
| A1 | `play` with tracks; Music's first `ui.json`: album, artist, mix, radio, mood, genre and track pages | 5-8, 35 | change 6 | Opus 5.5 high |
| A2 | Shelves and track rows; Home, Your Library, Search, Folders | 1-4, 9-18, 24 | change 7 | Opus 5.5 high |
| A3 | Playlists: Add to playlist, create, edit, cover, delete, reorder, remove, smart rules, M3U | 19-23 | change 8 | Opus 5.5 high |
| A4 | The player's additions from the document; `reloads` and `follows` | 38-40 | change 9 | Opus 5.5 high |
| A5 | Settings: playback, equalizer, appearance, privacy, devices, the library, scan, duplicates | 26-32 | none | Sonnet 5.5 high |
| A6 | Stats and Wrapped | 33-34 | none | Sonnet 5.5 high |
| A7 | Offline downloads and the Downloads screen | 36-37 | change 10 | Opus 5.5 xhigh |
| A8 | The web player's keyboard shortcuts on every page | 41 | none | Sonnet 5.5 medium |
| A9 | End to end on the local demo, then the default (`preview` goes) | all | none | Opus 5.5 high |
| A10 | Remove Music's own interface | – | none | Sonnet 5.5 medium |

**A1 - `play` with tracks, and the first pages.** **Done.** `play` takes `tracks` or `route`
with `start`, `shuffle`, `queue` and `context` (change 6, without the paging, which moves to A2
with the long lists). Each host has a `playTracks(satellite, tracks, options)` that refuses
another library's page (`mission_control/media/handover.js`, `mobile/src/media/handover.ts`).
Music's `ui.json` is a preview with temporary entry tabs (Recent, Discover, Genres, until A2's
Home, Library and Search) and the album, artist, mix, radio, mood, genre and track pages.
Music's answers carry `context`, and `mosaic_key` for `artwork/mosaic/<id>.<id>.<id>.<id>`,
four covers in a 2x2 square kept in the artwork cache (the first cover alone with fewer, or
without Pillow); `genres?name=` is the genre page. As planned:
- Contract: change 6 in `ui_contract.py`, `vocabulary.json`, `contracts/ui/fixtures/`
  (valid and refused `play` actions), `mission_control/ui/renderer.js` and
  `mobile/src/satellites/ui/UiBlocks.tsx`, which hand the tracks to the hosts
  (`mission_control/media/player.js`, `mobile/src/media/player.ts`: a `playTracks` beside
  `playSearch`, for the document's own provider).
- Music: `satellites/native/music/ui.json` (`preview: true`) with the album, artist, mix,
  radio, mood, genre and track (credits) pages, each with Play, Shuffle and a track list that
  plays from its row; the cover route (S).
- Tests: the Engine's (`test_ui_contract.py`: `play` with `tracks` in a Satellite without
  `audio.library` is refused; a `route` stays the Satellite's own), `contracts/ui/tests/web.test.mjs`,
  Jest for the renderer and the host's `playTracks`, Music's routes in the engine tests; the
  pages on the web and the emulator.

**A2 - shelves and track rows; Home, Your Library, Search, Folders.**
- Contract: change 7 (`layout: "row"`; a `media-list`'s `key`, `more`, `group`, `quick`, `menu`
  and `item.audio`) in the Engine, the fixtures, `mission_control/ui/` (a row menu beside
  `gallery.js`, `listpaging.js` for the rows) and `mobile/src/satellites/ui/`
  (`VirtualListPage.tsx`, a row sheet).
- Music: the Home, Search and Your Library tabs (one `choice` for the seven tabs), the folder
  pages with a `breadcrumb`; `home`, `library` and the row fields (S).
- Both renderers (no contract change): going back to a page restores its scroll position and
  the pages of a paged list already loaded, so returning from an album lands on the same row of
  Your Library. Mission Control keeps them per history entry; Android per screen in the stack.
- Tests: fixtures for each new key; renderer tests on both clients (a menu leaves out what the
  client can't run, a heart pair toggles, paging keeps a row's key, going back restores the
  position); Music's engine tests for
  `library` (each tab, the filter, a cursor); 10,000 liked songs flung through on the emulator.

**A3 - playlists.**
- Contract: change 8 (`choose` with `create` and `conflict`; `reorder`) in the Engine, the
  fixtures and both renderers.
- Music: Add to playlist in every row's menu; the playlist page (edit, cover, delete, export,
  reorder, remove); smart playlists' rules as form `rows`; M3U import through `upload`; the
  raw-body routes and the `409` (S).
- Tests: fixtures; renderer tests (a declined conflict runs nothing, a failed move is put
  back); Music's engine tests for import, cover and duplicates; both clients.

**A4 - the player's additions from the document.**
- Contract: change 9 (`audio`, `reloads`, `follows`) in the Engine, the fixtures and both
  hosts: `mission_control/media/` reads the provider's document instead of `extensions.js`, and
  `mobile/src/media/AudioHost.tsx` instead of `AudioHostExtensions`. The own interface keeps
  registering its extensions until A10, and they win while it is shown.
- Music: its `audio` section.
- The hosts: while the context is a radio (an endless queue the host refills), the repeat
  button cycles between off and repeat one only; repeat all has no end to loop back from.
- Tests: `node --test mission_control/tests/media.test.mjs` (the menu and links from a
  document, none without one, a `reloads` re-reads the preferences), Jest for the Android host;
  both clients, from Music's pages and from another Satellite's.

**A5 - settings.** Music's Settings page as forms, toggles and sliders with `reloads`; the
equalizer page; the library's settings with `rows`; the scan page refreshing every 2 s with
Cancel; duplicates; devices (S: `connect/forget`). Tests: Music's engine tests for the
preference keys and the configuration; a setting changed on the page heard at once, on both
clients.

**A6 - stats and Wrapped.** Two `dashboard` pages: the range as a `choice`, metrics, rankings
as `media-list`s, plays by hour as a `bars` chart; Wrapped by year, with Play your top songs
(change 6). Tests: Music's engine tests for `wrapped`'s `previous` and `next`; both clients.

**A7 - offline downloads.**
- Contract: change 10 (`media.audio-offline`, the `offline` action, the `sync_capabilities`
  entry) in the Engine, the fixtures and the app: the Downloads screen and the control move
  from `mobile/src/music/screens/DownloadsScreen.tsx` and `ui/TrackActions.tsx` to generic code
  beside `mobile/src/media/downloads.ts`, which keeps `starcore_music_downloads` and
  `files/music/`, so the copies already on a phone survive. Mission Control hides both.
- Music: Download on album, playlist and mix pages and in the row menu, and a Downloads link
  in Your Library.
- Tests: Jest for the action (queued, held by the network rule, removed) with the existing
  `downloads.ts` tests unchanged; airplane mode on the emulator, playing kept songs.

**A8 - keyboard shortcuts.** `mission_control/media/keys.js` is active wherever the host has a
track, except while typing, with a menu or a dialog open, or while the shared media viewer is
(it owns the arrows); `/` focuses the page's `search` block, if it has one. The `.pl-root`
check and the `focusSearch` extension go. Tests: a unit test for the rule
(`mission_control/tests/media.test.mjs`) and a check in the browser.

**A9 - end to end, then the default.** The whole interface on the isolated demo engine with a
test library, on the web and the emulator, every row of the matrix done or accepted; a short
review of what a document can make the host do (only its own provider, only its own routes).
Then `preview` goes: the document is the default, and the own interface moves to Developer
Mode on both clients. The owner validates it on the web and the phone.

**A10 - remove Music's own interface** (after the owner's validation):
- `satellites/native/music/mission_control/` (`page.js`, `page.css`, `views/`, `ui/`,
  `styles/`, `api.js`, `store.js`, `router.js`): the Satellite publishes no page.
- `mobile/src/music/` with its tests; `builtins.tsx` (empty by then) and its uses in the
  Satellites stack and `MainTabs.tsx`; `DEDICATED_SCREENS` and the own-screen helpers in
  `HomeScreen.tsx`, `SatellitesListScreen.tsx` and `SatelliteUiScreen.tsx` where nothing else
  needs them; `mission_control/media/extensions.js` and `AudioHostExtensions`.
- `engine/tests/test_client_modularity.py`: `SATELLITE_SPECIFIC` lists no folder,
  `KNOWN_COUPLINGS` loses `HomeScreen.tsx` and `KNOWN_IMPORTS` `builtins.tsx`;
  `KNOWN_CROSS_SATELLITE`'s last entry goes by renaming the type in
  `satellites/native/music/library.py` that the pattern matches. All three are then empty,
  stage 5's "Done".
- Docs: this file's references to the own interface, `docs/satellites/music.md`,
  [Remaining work](remaining-work.md), `CHANGELOG.md`, `mobile/README.md`.

### Risks and open points

- **A2's rows are the biggest piece.** A `media-list` with menus, paging and Android's
  virtualized page is used by nearly every page; it is built and measured first on Liked Songs.
- **Library size:** pages ask the server for one tab and one page at a time, never the whole
  library, as the own pages did.
- **The greeting's hour** is the server's; the mixes don't depend on it. Accepted.
- **Accepted losses (N):** search suggestions and the genre filter (#15), the web sidebar
  (#25), the equalizer applying while dragging (#27). Each can come back later as a generic
  block.
- **No backward compatibility:** the five changes may break older documents; every `ui.json`,
  both clients and the fixtures change together, as the rules say.
