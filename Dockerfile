# Single-service image: Node API + Python watermark service in one container.
# (Railway-friendly: one service, one volume, no private networking needed.)

# Stage 1: Node deps (better-sqlite3 native build)
FROM node:22-slim AS nodedeps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --production

# Stage 2: Python base + Node runtime
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
# Node binary from the same Debian base (glibc-compatible)
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

# CPU-only torch keeps the image ~2GB smaller than the default wheel
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# VideoSeal + watermark service deps
RUN git clone --depth 1 https://github.com/facebookresearch/videoseal.git /app/videoseal \
    && pip install --no-cache-dir fastapi uvicorn python-multipart numpy Pillow \
       omegaconf einops timm==0.9.16 safetensors requests scipy PyWavelets \
       pytorch_msssim lpips av opencv-python-headless pycocotools tqdm pandas \
    && pip install --no-cache-dir -e /app/videoseal --no-deps

# Bake the checkpoint (218MB) so cold starts don't download it.
# videoseal resolves configs/ckpts relative to cwd -> service runs from the clone dir.
WORKDIR /app/videoseal
RUN python -c "import videoseal; videoseal.load('videoseal')"
COPY watermark/codec.py watermark/media.py watermark/app.py ./

WORKDIR /app
COPY --from=nodedeps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY web ./web
COPY start.sh .
RUN chmod +x start.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/trustcam.db
ENV WATERMARK_URL=http://127.0.0.1:8000

# Persistence: mount a volume at /data (on Railway: add a Volume with mount path /data)
EXPOSE 3000
CMD ["./start.sh"]
