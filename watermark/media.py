# Embed/extract VideoSeal watermarks in images and videos.
# Video I/O streams through ffmpeg pipes so memory stays bounded.
import json
import os
import subprocess

import torch
import numpy as np
from PIL import Image

import videoseal

CHUNK = 16
MAX_EXTRACT_FRAMES = 96  # cap extraction work on long videos

_model = None


def model():
    global _model
    if _model is None:
        _model = videoseal.load('videoseal')
        _model.eval()
    return _model


def is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi')


# --- images ---

def embed_image(src: str, dst: str, msg: torch.Tensor):
    img = Image.open(src).convert('RGB')
    t = torch.from_numpy(np.asarray(img)).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    with torch.no_grad():
        out = model().embed(t, msgs=msg, is_video=False, lowres_attenuation=True)
    wm = (out['imgs_w'].clamp(0, 1) * 255).byte().squeeze(0).permute(1, 2, 0).numpy()
    Image.fromarray(wm).save(dst, quality=95, exif=img.getexif())


def extract_image(src: str) -> torch.Tensor:
    img = Image.open(src).convert('RGB')
    t = torch.from_numpy(np.asarray(img)).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    with torch.no_grad():
        preds = model().detect(t, is_video=False)['preds']
    return preds[0, 1:]  # (256,) logits, first channel is the detection mask


# --- videos ---

def _probe(path: str):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height,r_frame_rate',
         '-of', 'json', path], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = s['r_frame_rate'].split('/')
    return int(s['width']), int(s['height']), float(num) / float(den)


def embed_video(src: str, dst: str, msg: torch.Tensor, crf: int = 18):
    w, h, fps = _probe(src)
    dec = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:'],
        stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-y',
         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(fps), '-i', 'pipe:',
         '-i', src, '-map', '0:v', '-map', '1:a?', '-c:a', 'copy',
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', str(crf), dst],
        stdin=subprocess.PIPE)

    frame_bytes = w * h * 3
    m = model()
    while True:
        chunk = []
        for _ in range(CHUNK):
            raw = dec.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            chunk.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3))
        if not chunk:
            break
        t = torch.from_numpy(np.stack(chunk)).permute(0, 3, 1, 2).float() / 255.0
        with torch.no_grad():
            out = m.embed(t, msgs=msg, is_video=True, lowres_attenuation=True)
        wm = (out['imgs_w'].clamp(0, 1) * 255).byte().permute(0, 2, 3, 1).numpy()
        enc.stdin.write(wm.tobytes())
    dec.stdout.close()
    enc.stdin.close()
    dec.wait()
    if enc.wait() != 0:
        raise RuntimeError('ffmpeg encode failed')


def extract_video(src: str) -> torch.Tensor:
    w, h, fps = _probe(src)
    dec = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:'],
        stdout=subprocess.PIPE)
    frame_bytes = w * h * 3
    m = model()
    softs = []
    frames_done = 0
    while frames_done < MAX_EXTRACT_FRAMES:
        chunk = []
        for _ in range(CHUNK):
            raw = dec.stdout.read(frame_bytes)
            if len(raw) < frame_bytes:
                break
            chunk.append(np.frombuffer(raw, np.uint8).reshape(h, w, 3))
        if not chunk:
            break
        t = torch.from_numpy(np.stack(chunk)).permute(0, 3, 1, 2).float() / 255.0
        with torch.no_grad():
            preds = m.detect(t, is_video=True)['preds']
        softs.append(preds[:, 1:])
        frames_done += len(chunk)
    dec.stdout.close()
    dec.kill()
    if not softs:
        raise RuntimeError('no frames decoded')
    return torch.cat(softs, dim=0).mean(dim=0)  # (256,)
