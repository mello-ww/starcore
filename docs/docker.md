# StarCore in Docker (optional)

Docker is **optional**. The supported way to run StarCore is `deploy/linux/install.sh` and
systemd (`docs/deployment.md`). The container is for trying StarCore without installing
anything, or for hosts where you would rather run containers.

It runs the same thing as the server: the Engine, Mission Control and every Satellite, with
Python 3.13, the `thumbnails` and `encryption` extras and FFmpeg.

## Files

| File | What |
|---|---|
| `Dockerfile` | builds the image |
| `compose.yaml` | runs it with its volumes |
| `deploy/docker/entrypoint.sh` | on start, writes each `config.toml` that does not exist yet, then runs StarCore. An existing `config.toml` is never touched |
| `.dockerignore` | keeps tests, docs, the Android app and local state out of the image |

## Run it

```
docker compose up --build
```

Mission Control is then on `http://<host>:8090`. Create the administrator account on first
visit, as on the server. To use another port, set `STARCORE_PORT` and change the published port.

Without Compose:

```
docker build -t starcore .
docker run --rm -p 8090:8090 -v starcore-data:/data starcore
```

## Where things live

| In the container | What | Kept in |
|---|---|---|
| `/data` | accounts, sessions, audit log, Status history, Music's index, Locked Folder state (`STARCORE_DATA_DIR`) | the `starcore-data` volume |
| `/srv/starcore/music` | what Music scans | a folder on the host |
| `/srv/starcore/files` | what File Explorer browses | a folder on the host |
| `/srv/starcore/photo` | the Photo library | a folder on the host |

The three media folders are taken from `STARCORE_MEDIA` on the host (default `./srv`, so
`./srv/music`, `./srv/files`, `./srv/photo`):

```
STARCORE_MEDIA=/path/to/media docker compose up -d
```

Settings a Satellite saves into its `config.toml` stay in the container's writable layer: they
are lost if the container is removed and recreated.

## Good to know

- Mission Control listens on every interface *inside* the container. Who can reach it is
  decided by the published port (`ports:` in `compose.yaml`). For HTTPS, put a reverse proxy in
  front, as in `deploy/nginx/starcore-panel.conf`.
- The container runs as an unprivileged user. The host media folders must be writable by it.
- Do not mix this with the systemd install on the same host and port.
- This is separate from the **Docker Satellite**, which is a link to a Docker server and is
  still only a placeholder (`docs/remaining-work.md`).
- The image has not been built in CI or on the owner's server yet.
