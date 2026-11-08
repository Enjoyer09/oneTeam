# oneTeam — TorchVision detector worker
#
# Build from repository root:
#   docker build -f vision-worker/Dockerfile -t oneteam-vision-worker .
#
# No model weights are baked into this image. The safe default backend is
# disabled until an audited custom checkpoint is mounted and configured.

FROM python:3.12-slim

WORKDIR /app

# Pin the CPU runtime pair so upstream releases cannot silently change the
# worker's ABI or pull CUDA libraries into this image.
RUN pip install --no-cache-dir \
    torch==2.14.0 torchvision==0.29.0 \
    --index-url https://download.pytorch.org/whl/cpu

COPY vision-worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY scripts/torchvision_inference.py /app/scripts/torchvision_inference.py
COPY vision-worker/server.py /app/server.py

# Containers reach each other over the bridge network, never over loopback,
# so exposure is explicit here. The inference endpoint stays fail-closed: the
# worker answers 503 until ONETEAM_VISION_TOKEN is set (and the bot holds the
# same value).
ENV PORT=8080
ENV ONETEAM_VISION_HOST=0.0.0.0
ENV ONETEAM_TORCHVISION_MODE=disabled
EXPOSE 8080

CMD ["python", "server.py"]
