# StarCore in a container: the Engine, Mission Control and every Satellite in the checkout.
#
#   docker build -t starcore .
#   docker run --rm -p 8090:8090 -v starcore-data:/data starcore
#
# The image mirrors the Linux server (docs/guide/deployment.md): Python 3.13, the `thumbnails` and
# `encryption` extras, FFmpeg. Accounts, sessions, libraries and Locked Folder state live in
# the /data volume (STARCORE_DATA_DIR); the media (music, files, photo) is /srv/starcore.
# Settings a Satellite saves into its config.toml stay in the container's writable layer.

FROM python:3.13-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --home-dir /home/starcore --shell /usr/sbin/nologin starcore \
    && mkdir -p /app /data /srv/starcore/music /srv/starcore/files /srv/starcore/photo \
    && chown -R starcore:starcore /app /data /srv/starcore

USER starcore
WORKDIR /app/engine

# dependencies first, so a code change does not reinstall them
COPY --chown=starcore:starcore engine/pyproject.toml engine/uv.lock engine/.python-version ./
ENV UV_PROJECT_ENVIRONMENT=/app/engine/.venv \
    UV_PYTHON_PREFERENCE=system \
    UV_LINK_MODE=copy
RUN uv sync --frozen --no-install-project --extra thumbnails --extra encryption

COPY --chown=starcore:starcore engine/ /app/engine/
COPY --chown=starcore:starcore satellites/ /app/satellites/
COPY --chown=starcore:starcore mission_control/ /app/mission_control/
COPY --chown=starcore:starcore contracts/ /app/contracts/
COPY --chown=starcore:starcore VERSION /app/VERSION
COPY --chown=starcore:starcore --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/starcore-entrypoint

ENV STARCORE_DATA_DIR=/data \
    PATH="/app/engine/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

VOLUME ["/data", "/srv/starcore"]
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8090/api/auth/status', timeout=4)"

ENTRYPOINT ["starcore-entrypoint"]
CMD ["python", "-m", "starcore"]
