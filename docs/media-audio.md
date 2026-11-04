# Audio playback: `media.audio` and `audio.library`

Status: **specification**, with its contract groundwork in place: `audio.library` v1 is in
`contracts/ui/vocabulary.json` and Music provides it. No client plays through it yet. Music's current web player (`satellites/native/music/mission_control/
player/`, `audio/`) and Android player (`mobile/src/music/`, `android/.../music/`) are the
behavioural reference: each section says which file it describes. See
[UI contract](ui-contract.md), "Two kinds of capability", for the general model.

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
| Persistence | the queue on the server (`GET/POST queue?device=`) | `starcore_music_queue:<server>` locally, plus the server queue |

### Effects

Effects are optional. Each one reports `{applied, reason}` and never fails playback:
equalizer, bass boost, loudness, ReplayGain, normalisation, speed and pitch.
- **Web:** Web Audio (`audio/effects.js`).
- **Android:** `StarCoreAudioModule.kt`. Its Kotlin package stays `com.starcore.mobile.music`
  for now; renaming it is cosmetic and not part of this work.

### Connect

StarCore Connect (moving playback between a listener's devices) stays a Music feature, because
the relay is Music's server routes (`connect/*`). The AudioHost exposes one integration point:
- a **remote target**, which takes the transport commands and reports `remote` state, plus a
  way to export and import the queue for a transfer.

Music's `connect.js` and `mobile/src/music/connect.ts` become that target's implementation.
Hosts show "Playing on <device>" and route controls to it without knowing Connect exists.

### Offline downloads

Downloads are an Android client feature (`StarCoreDownloadsModule.kt`,
`starcore_music_downloads:<server>`). A resolved local file wins over the stream. A document
that depends on them declares `requires.client: ["media.audio"]` and checks its own features.

## The shared player UI

The AudioHost owns the player UI, so every audio Satellite gets the same one. The current
implementation is the specification. Visual language: floating rounded surfaces, pill
controls, the global accent for active states, restrained motion.

| Element | Behaviour to keep | Web reference | Android reference |
|---|---|---|---|
| Floating bar | a rounded bubble clear of the edges, drawn over content (no backing rectangle); cover, title, artist, like, transport, seek; the cover opens the full player | `bar.js`, `styles/player.css` (`.mu-bar`) | `MiniPlayer.tsx`, mounted over the screens in `MainTabs.tsx` |
| Retract | a chevron (and a swipe down on Android) puts the bar away; the choice is remembered | `starcore.music.playerCollapsed` | `starcore_music_player_collapsed` (`dock.ts`) |
| Top-bar disc | the playing cover as a disc, spinning while playing, with an accent ring while the bar is open; tap toggles the bar | `#topbar-extras` slot (`index.html`) | `TopBarSlot` in every header |
| Transition | the cover flies between the disc and the bar, between measured positions; skipped when reduced motion is on | Web Animations in `bar.js` | `MusicFlight`, `dock.ts` anchors |
| Scroll space | screens keep their last row clear of the bar, using the bar's measured height, only while it shows | `body.mu-has-bar` padding | `FloatingPlayerInset` / `FloatingPlayerSpacer` |
| Full player | artwork, lyrics, queue, devices and info as pill tabs | `fullscreen.js` | `FullPlayer.tsx` |

The full player's lyrics tab appears when the track's provider offers `lyrics`, and the devices
tab when a remote target is registered. Info shows what the resolved `plan` reports.

## Compatibility

- Music's REST routes stay exactly as they are. The released Alpha app and Music's own page use
  them directly.
- Persisted state keeps its keys, read as they are and never renamed: `starcore.music.*`
  (web) and `starcore_music_*` (Android). The AudioHost reads Music's existing keys. A rename,
  if it ever happens, is a migration with a fallback read.
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

### 3. Android AudioHost

- Move the player controller, `dock.ts`, `MiniPlayer`, `FullPlayer`, `MusicDisc`/`MusicFlight`
  and the effects and downloads bridges behind a generic host in `mobile/src/media/`.
- MainTabs mounts the host instead of `MusicProvider`.
- The host resolves the provider through the catalog instead of `MUSIC_BASE`.
- Music's screens call the host.

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

### 4. Web AudioHost

- Move `player/`, `audio/` and the bar into `mission_control/media/`, started by the shell at
  sign-in rather than by Music's page.
- Music's `page.js` keeps its library views and calls the host.

Accepted when:
- The bar and disc appear on any page once something plays, including after a reload before
  Music's page is opened. This fixes today's gap.
- Media Session controls, the autoplay tap, the effects, Connect and the collapsed state
  (`starcore.music.playerCollapsed`) behave as before.
- The shell names no Satellite, and Music's page works with the host.

### 5. A second consumer

A test Satellite (an example under `examples/`) plays a track from `audio.library` without
naming Music. Only then is a `track-picker` block designed, as the counterpart of
`file-browser`.

### Risks

- Background behaviour differs by Android version and vendor: test on real hardware.
- Browsers block audio without a gesture: keep the `blocked` state.
- Connect transfers carry the queue format: keep the format unchanged across the move.
