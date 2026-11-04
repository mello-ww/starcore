# Status

The Status satellite monitors the machine StarCore runs on: health, CPU, memory, storage,
network, the engine and every satellite, with a bounded history. It is shown in four places,
all fed by the same snapshot:

| Where | What |
| --- | --- |
| Mission Control → Status | Overview, Hardware, Network, Services, History and Diagnostics |
| Mission Control and the Android app → Home | Status's widget: health, CPU, memory, satellites online, top warnings |
| Android app → Satellites → Status | the same sections |
| CLI | `status`, `status hardware`, `status network`, `status services`, `status history` |

Its interface is described once, in `ui.json` (UI contract 1.1, see
[docs/ui-contract.md](../ui-contract.md)), and drawn by both clients' shared renderers: Status
is the first existing Satellite migrated off client code of its own. See "Interface" below.

Every value is a real reading. Anything a machine can't provide is shown as unavailable
with the reason - never estimated, never invented.

## How it works

```
satellites/native/status/
    linux.py      readings from /proc and /sys
    windows.py    readings from the Win32 API (ctypes)
    metrics.py    one snapshot: rates, percentages, partition usage with a time limit
    health.py     warnings and the overall state
    services.py   the engine, satellites, dependencies, optional components
    history.py    the bounded history file
    monitor.py    the sampler thread, the cached snapshot, on-demand readings
    satellite.py  start/stop hooks: the sampler is Status's background service
    state.py      the Home summary, published with every satellite listing
    view.py       the snapshot shaped for display: what ui.json binds to
    api.py        metrics, history, diagnostics, view, mobile
    ui.json       the interface, for every client (UI contract 1.1)
    commands/status.py           the CLI namespace
    mission_control/page.js      the previous web page, kept for one release (see "Interface")
```

Standard library only - no psutil or other package. While Status's service runs (it starts
with StarCore unless `[satellites] services = false`), a background thread takes a sample
every `sample_interval` seconds, keeps it in memory, and folds it into the history file.
Everything else reads that snapshot instead of measuring again, so more open views never
mean more sampling:

- the Status pages read `view` every 5 seconds (the default sample interval), and history
  less often, only while they are open - in a visible browser tab, or on a focused screen
  with the app in the foreground;
- Home shows Status's widget from the summary Status publishes as its satellite state, which
  arrives with the `/api/satellites` listing Home already polls - no request of its own;
- CLI commands read the latest snapshot. With no sampler running (the one-shot CLI with
  StarCore stopped, or satellite services turned off), a reading is taken on the spot -
  at most once a second - and nothing is written.

## Readings

| Reading | Linux | Windows |
| --- | --- | --- |
| CPU usage, overall and per thread | `/proc/stat` | `GetSystemTimes`, `NtQuerySystemInformation` |
| Load average (1, 5, 15 min) | `os.getloadavg()` / `/proc/loadavg` | **not available**: Windows has no load average |
| CPU frequency | `cpufreq` in `/sys`, else `/proc/cpuinfo` | the Processor Frequency and % Processor Performance counters (Task Manager's "Speed"); base frequency too |
| CPU temperature | `/sys/class/hwmon`, else `/sys/class/thermal` | **not available**: needs vendor tools or administrator WMI access |
| Memory, available memory | `/proc/meminfo` (`MemAvailable`) | `GlobalMemoryStatusEx` |
| Swap / page file | `/proc/meminfo` | page file sizes and use from `NtQuerySystemInformation` |
| Partitions, capacity, free space | `/proc/mounts` + `statvfs` (real file systems only, each device once) | logical drives, drive type and file system |
| Disk throughput and busy time | `/proc/diskstats` (physical disks only) | PhysicalDisk performance counters |
| Network interfaces, state, link speed | `/proc/net/dev`, `/sys/class/net` | `GetIfTable2` |
| Throughput, traffic since the adapter came up, errors, drops | same | same |
| OS, kernel, uptime, hardware vendor and model, CPU model | `/etc/os-release`, `/proc/uptime`, `/sys/class/dmi/id`, `/proc/cpuinfo` | `platform`, `GetTickCount64`, the registry's hardware description |
| StarCore's own CPU share and memory | `time.process_time()`, `/proc/self/statm` | `time.process_time()`, `K32GetProcessMemoryInfo` |

Also unavailable, and reported as such:

- macOS and BSD: only the system description and load average; everything else says the
  platform isn't supported yet.
- Linux in a virtual machine or container often has no `cpufreq` driver and no temperature
  sensors; those readings then say so.
- The maximum CPU frequency on Windows (the base frequency is shown instead).
- Rates (CPU usage, throughput, busy time) need two readings, so the very first snapshot has
  none; the page and the app fill them in on the next poll.

Partition usage can hang on a disconnected network share or a dead NFS mount, so it is read on
its own worker thread with a time limit and refreshed at most every 30 seconds. A drive that
stops answering makes the storage figures stale (and says so) instead of stopping sampling.

Network totals count physical adapters only when there are any: bridges and virtual switches
carry traffic a physical adapter already counted.

### What is never collected

IP and MAC addresses, serial numbers, process lists, user names, environment variables and file
contents. Diagnostics show no file paths. The host name, mount points and drive labels are shown,
to signed-in sessions only.

## Health and warnings

CPU and memory use the average of the last minute, so a short spike raises nothing; the rest
use the latest reading.

| Warning | Warning at | Critical at |
| --- | --- | --- |
| CPU busy (1-minute average) | 90 % | 98 % |
| Memory almost full (1-minute average) | 90 % | 97 % |
| Swap almost full | 80 % | 95 % |
| A drive almost full (fixed, removable or network) | 90 % used | 97 % used |
| CPU hot | 85 °C | 95 °C |
| A satellite's last start or stop failed | - | always |
| An enabled satellite's service is stopped | always | - |
| Mission Control enabled but not serving | always | - |
| Storage figures stale, sampler stalled | always | - |

When StarCore itself isn't running (the CLI reading on request), these collapse into one
"StarCore is not running" warning. The overall state is `critical`, `warning` or `ok`.

## History

`history.db` (SQLite, in StarCore's data directory under `satellites/Status/`, or wherever the
`storage` setting points). Each sample goes into a 10-second bucket; each finished bucket is
written and folded into the next tier:

| Tier | One point per | Kept for | Serves | Points |
| --- | --- | --- | --- | --- |
| `10s` | 10 seconds | 1 hour | the 1h view | 360 |
| `1m` | 1 minute | 24 hours | the 24h view | 1,440 |
| `10m` | 10 minutes | 7 days | the 7d view | 1,008 |
| `1h` | 1 hour | 30 days | the 30d view | 720 |

Every point keeps the average, the peak and the sample count of each series, so coarser tiers
are true averages and peaks are never lost. Older points are deleted as new ones are written,
so the file stays around 3,500 rows - a few hundred kilobytes - however long StarCore runs.
About 430 small writes an hour. Periods when StarCore was off are gaps, never interpolated.
A clean shutdown writes the partly filled buckets; after a restart new samples add to them
without counting anything twice. A damaged file is renamed `history.db.broken-<time>` and
history starts again. Reading history never creates the file.

Series: `cpu`, `memory`, `swap`, `load`, `temperature`, `disk_read`, `disk_write`, `net_rx`,
`net_tx` and `storage` (the fullest fixed or removable drive).

## Sampling overhead

Measured on Windows 11 (Intel i5-10600KF, 12 threads, Python 3.14), 100 consecutive samples:
median 1.5 ms per sample, 95th percentile 2.4 ms, worst 3.1 ms - under 0.05 % of one core at
the default 5-second interval. Partition usage is read on its own thread at most every 30
seconds. With a 2-second interval and Mission Control open on the Status page, StarCore's
whole process stayed at 0.3 % of the machine's CPU and 45 MiB of memory. The Diagnostics
section shows the live collection time. Linux readings are file reads from `/proc` and `/sys`.

## Interface

- **Overview**: warnings, then tiles for CPU, memory, the fullest drive, network, satellites
  and uptime (each with a meter or a last-hour trend), and last-hour CPU and memory charts.
- **Hardware**: processor (model, threads and cores, usage per thread, frequency, load,
  temperatures), memory and swap, every drive with its usage, disk activity, system.
- **Network**: download and upload rates, every interface (state, link speed, rates, totals,
  errors and drops), last-hour throughput.
- **Services**: the engine, pass/fail checks, every satellite with its status and last error,
  dependencies between satellites, optional components (Pillow, cryptography, FFmpeg).
- **History**: a 1h / 24h / 7d / 30d range above every chart. On the web a crosshair shows
  every series at that moment, with its peak, and the arrow keys step through points; on
  Android a finger does. Every chart's "Show values" lists the same values. Charts the machine
  can't record are listed with the reason.
- **Diagnostics**: the sampler, StarCore's own process, the history file and its tiers, every
  unavailable reading with its reason, and the raw JSON. Shown in Developer Mode only (the
  route itself is signed-in only either way - see docs/satellites.md, "Developer Mode").

Meters carry severity: neutral below the warning threshold, then the warning colour, then the
danger colour - never the accent, which would look like danger with the red preset. Chart lines
use the accent; a second series uses `--sc-chart-2` without a fill. Units follow the UI
contract's formats: sizes in powers of 1024 (shown as KB, MB, GB), disk throughput in bytes per
second, network throughput in bits per second to match link speeds. When StarCore stops
answering, the last readings stay on screen, dimmed, with how old they are.

### How the interface is built

`ui.json` describes the pages, the header (health and when it was updated), the navigation
(Diagnostics is a Developer Mode page) and the Home widget. It uses UI contract 1.1's
dashboard template, charts, tables, the period choice and status blocks, and binds to three
routes: `view` (every tab but History), `view/diagnostics`, and `history`, which charts bind
to directly. `view.py` is the one Status-specific step: UI documents have no expression
language, so it decides what a tile shows (the fullest drive), the tone of each reading (from
the same thresholds health.py warns at), and builds lines of text with the contract's own
`format_value`. It measures nothing: every value comes from the cached snapshot.

The Home widget binds to the summary in `state.py`, which now also carries the widget's
display keys (`health_label`, `health_tone`, `cpu_tone`, `memory_tone`, `satellites`,
`warning_items`) beside the keys the Alpha app reads.

### Status's migration

Status's previous interfaces stay for one release, so the shared one can be checked against
them:

- **Mission Control** uses `ui.json`. `mission_control/page.js` is the fallback if the document
  is ever refused, and in Developer Mode the button beside the Satellite's title switches
  between the two. Its charts, meters and sparklines are now Mission Control's shared ones
  (`mission_control/ui/charts.js`), which its `charts.js` re-exports.
- **The Android app** opens Status in the shared `SatelliteUiScreen`. `StatusHomeScreen` and
  Home's dedicated Status card are what the app uses with a server older than this
  `ui.json`, so a newer app on an Alpha server loses nothing. Its column chart and meter are
  now the app's shared ones (`mobile/src/components/charts.tsx`).
- **The Alpha app** (0.1.0-alpha.1) keeps opening its own Status screen, which reads the
  `metrics` and `history` routes, unchanged.

Feature by feature:

| | Previous web page | Previous Android screen | Shared interface |
| --- | --- | --- | --- |
| Header: node, health, warning count, last update, sampling | yes | yes | yes, both clients |
| Overview: warnings, 6 tiles, last-hour CPU and memory | yes (tiles with sparklines) | yes (no sparklines) | yes, sparklines on both |
| Tiles open their section | yes | no | yes, both |
| Hardware: processor, per-thread bars, memory, swap, drives, disk activity, system | yes | yes | yes |
| Network: rates, interfaces, last-hour throughput | yes | yes | yes |
| Services: engine, checks, satellites, dependencies, components | yes | yes | yes |
| History: 4 ranges, 8 charts, unsupported list, values as a table | yes | yes (no table) | yes, table on both |
| Diagnostics (Developer Mode) with raw JSON and Copy | yes | no | yes, both |
| Refresh: polling while visible, pull to refresh | yes / - | yes / yes | yes / yes |
| Offline: last readings kept, dimmed, with their age; retry when nothing loaded | yes | yes | yes |
| Home summary | dedicated card | dedicated card | the Satellite's widget, both |

Differences that remain, by design or for later:

- Sizes read "GB" where the previous screens said "GiB" (the same powers of 1024): the UI
  contract has one `bytes` format for every Satellite.
- Percentages keep one decimal ("74.5%") where the previous screens rounded above 10%.
- Navigation is the shared tab style (pills with icons) rather than Status's own segmented
  bar, on both clients.
- On the web, Hardware's per-thread bars are a `bars` chart; the previous page's bars were
  the same shape.

Once this release is validated, `page.js` and its stylesheet, `StatusHomeScreen` and its
sections, and the dedicated Home cards are removed, together with their entries in
`engine/tests/test_client_modularity.py`.

## API

All under `/api/satellites/status/`, GET only, signed-in sessions only (like every satellite
route).

| Route | Answers |
| --- | --- |
| `metrics` | the latest snapshot: `node`, `interval`, `sampling`, `sampled_at`, `health`, `cpu`, `memory`, `storage`, `network`, `system`, `process`, `services`, `unsupported`, `collect_ms` |
| `history?period=1h\|24h\|7d\|30d&series=cpu,memory&points=N` | `{period, resolution, from, to, sampling, interval, series: {name: {unit, points: [[time, average, peak], ...]}}}`; `points` (10-2000) divides the whole period into at most N fixed, clock-aligned slots (`resolution` says how long each is), however much of the period has samples |
| `diagnostics` | sampler statistics, the history file's size and rows per tier, StarCore's process, unavailable readings |
| `view` | the latest snapshot shaped for display (`header` keys, `overview`, `hardware`, `network`, `services`, `history_notes`) - what `ui.json` binds to; see `view.py` |
| `view/diagnostics` | `diagnostics` shaped for display, with the raw answer under `raw` |
| `mobile` | the generic declarative screen of UI contract v0, for older clients |

A reading that isn't available is `null`; the reason is under `unsupported`. Invalid query
parameters answer `400`.

## CLI

```
status                            health, engine, satellites, CPU and memory
status hardware                   CPU, memory, swap, drives, disk I/O, temperatures (alias: status metrics)
status network                    interfaces with link speed, throughput, traffic and errors
status services                   engine, satellites, dependencies, components
status history --period 24h       latest, average, peak and an ASCII trend per series
status history --period 7d --series cpu,memory --json
```

All read-only (`status.read`), so a signed-in Mission Control or mobile console may run them
too. `--period` accepts `1h`, `24h`, `7d` or `30d`; an unknown period or series exits with 2.

## Settings

Optional keys in `satellites/native/status/config.toml` (they are deliberately not in
`config.default.toml`, so nothing is added to an existing config automatically):

| Key | Default | Meaning |
| --- | --- | --- |
| `sample_interval` | `5` | seconds between samples, 2-60 |
| `storage` | `"data"` | where `history.db` lives; `"data"` means StarCore's data directory |

`refresh_rate` from older configs is no longer used.

## Other machines

Monitoring covers the machine StarCore runs on. The format is ready for more: every snapshot
names its `node` (`{"id": "local", "name": <host name>, "kind": "local"}`), history rows carry
a node name, and collection sits behind a backend interface. A separate machine - the
Ollama/Open WebUI server, or a future Wings node - could later run the same collector and
report under its own node name. Remote monitoring is not implemented.

## Not covered

- GPU readings, fan speeds, battery and power draw.
- Per-process figures (other than StarCore's own).
- Linux was checked with a fake `/proc` and `/sys` tree in the tests, not on a real Linux host
  in this change.
