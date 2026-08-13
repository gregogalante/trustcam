FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch keeps the image ~2GB smaller than the default wheel
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# VideoSeal: install deps it actually needs at inference time, then the package itself
RUN git clone --depth 1 https://github.com/facebookresearch/videoseal.git /app/videoseal
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir omegaconf einops timm==0.9.16 safetensors requests scipy PyWavelets pytorch_msssim lpips av opencv-python-headless \
    && pip install --no-cache-dir -e /app/videoseal --no-deps
COPY requirements.txt .

# Bake the checkpoint into the image (218MB) so cold starts don't download it.
# videoseal resolves configs/ckpts relative to cwd -> run from the clone dir.
WORKDIR /app/videoseal
RUN python -c "import videoseal; videoseal.load('videoseal')"

COPY codec.py media.py app.py /app/videoseal/

ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port $PORT"]
