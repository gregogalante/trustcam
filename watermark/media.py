# Extract VideoSeal watermarks from images and videos (embedding happens
# on-device). Video I/O streams through ffmpeg pipes so memory stays bounded.
import json
import os
import subprocess

import torch
import numpy as np
from PIL import Image

import videoseal

CHUNK = 16
MAX_EXTRACT_FRAMES = 96  # cap extraction work on long videos


# Thread count: in containers os.cpu_count() reports HOST cores; oversubscribing
# a small cgroup quota (e.g. 32 torch threads on 2 vCPU) thrashes badly.
# Prefer the cgroup cpu quota, allow override via WM_THREADS.
def _cpu_quota():
    try:
        quota, period = open('/sys/fs/cgroup/cpu.max').read().split()
        if quota != 'max':
            return max(1, int(int(quota) / int(period)))
    except OSError:
        pass
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 4


_threads = int(os.environ.get('WM_THREADS', '0')) or _cpu_quota()
torch.set_num_threads(_threads)
print(f'watermark service using {_threads} torch threads')

_model = None


def model():
    global _model
    if _model is None:
        _model = videoseal.load('videoseal')
        _model.eval()
    return _model


def is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi')


def extract_image(src: str) -> torch.Tensor:
    img = Image.open(src).convert('RGB')
    t = torch.from_numpy(np.asarray(img)).permute(2, 0, 1).float().unsqueeze(0) / 255.0
    with torch.no_grad():
        preds = model().detect(t, is_video=False)['preds']
    return preds[0, 1:]  # (256,) logits, first channel is the detection mask


def _probe(path: str):
    """Effective (display) dimensions: ffprobe reports coded dimensions but
    ffmpeg's rawvideo decode autorotates, so rotation metadata must be resolved
    here or every frame downstream is shredded."""
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height:stream_side_data=rotation',
         '-of', 'json', path], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    w, h = int(s['width']), int(s['height'])
    rotation = 0
    for sd in s.get('side_data_list', []):
        if 'rotation' in sd:
            rotation = int(sd['rotation'])
    if abs(rotation) % 180 == 90:
        w, h = h, w
    return w, h


def extract_video(src: str) -> torch.Tensor:
    w, h = _probe(src)
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
