# oneTeam — vision worker
#
# A service whose only job is to hold one YOLO model in memory and answer JSON.
# It exists because the alternative was spawning a Python process per photo from
# inside the bot (47s cold, measured), and because ultralytics/torch must not be
# pushed into the API or bot images — .dockerignore keeps .venv out of those
# contexts on purpose.
#
# Build from the repository root so the worker script can be reused as-is:
#
#   docker build -f vision-worker/Dockerfile -t oneteam-vision-worker .
#
# The context is the repo root, so the root .dockerignore applies; it excludes
# **/*.pt, which is why the weights are downloaded at build time instead of
# copied — baking them here means a running container never needs outbound
# network to answer its first request.

FROM python:3.12-slim

WORKDIR /app

# CPU wheels first: ultralytics pulls in torch, and without this pip resolves
# the default wheel (several GB of CUDA that this container cannot use).
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

COPY vision-worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# The worker itself. Kept at /app/scripts/yolo_inference.py because that module
# derives its config directory from its own path (one level up), and
# server._worker_scripts_dir() looks for it there.
COPY scripts/yolo_inference.py /app/scripts/yolo_inference.py
COPY vision-worker/server.py /app/server.py

# Kept at .yolo_config under the repo root because the worker makedirs()' it
# relative to its own two-levels-up path (scripts/ -> root), which is /app in
# the image; the cache that ultralytics writes there is then part of a layer
# the running container shares on startup.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libxcb1 libxcb-shm0 libxcb-xfixes0 libxcb-shape0 libxcb-render0 \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Bake the weights and the torch import into the layer: the first /detect then
# costs what every later /detect costs.
ENV YOLO_CONFIG_DIR=/app/.yolo_config
RUN python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"

ENV PORT=8080
EXPOSE 8080

# $PORT comes from the platform (Railway assigns one), so this is the only
# listen address that matters.
CMD ["python", "server.py"]
