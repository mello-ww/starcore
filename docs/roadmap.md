# Roadmap

The roadmap represents the long-term direction of StarCore.

Items may change as the project evolves.

## Engine

- [x] Bootstrap
- [x] Configuration
- [ ] Storage
- [ ] API
- [ ] Signal Bus

## Mission Control

- [x] Dashboard
- [ ] Authentication

## Native Satellites

- [ ] Status
- [ ] Files
- [ ] Photos
- [ ] Music
    - [x] SQLite catalog with migrations, stable track identities, incremental and scheduled scans
    - [x] FLAC, MP3, WAV, M4A (AAC/ALAC), Ogg Vorbis and Opus metadata, credits, ReplayGain, quality
    - [x] Authenticated range streaming, optional FFmpeg transcoding to a bounded cache
    - [x] Playlists (smart, M3U import/export), likes, pins, history, stats, Wrapped
    - [x] Local, explainable discovery: Home, Daily Mixes, radio, moods
    - [x] Lyrics from sidecar LRC/TXT and tags (synced, word timing, translations)
    - [x] StarCore Connect devices, remote commands and handoff over long-poll
    - [ ] Metadata enrichment providers (MusicBrainz, Cover Art Archive), opt-in and rate limited
    - [ ] Optional external lyric lookup that respects provider terms
    - [ ] Scrobbling Links (Last.fm, ListenBrainz) fed from play history
    - [ ] OpenSubsonic API compatibility Link, and the Riff Link built on it
    - [ ] Collaborative playlists, once StarCore has more than one account and a sharing model
    - [ ] Audio analysis (BPM, key, loudness) for discovery and automatic normalisation

## Link Satellites

- [ ] Docker
- [ ] Home Assistant
- [ ] Jellyfin.......