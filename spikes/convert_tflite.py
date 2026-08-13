# Convert the VideoSeal embedder to TFLite (LiteRT) for on-device benchmark.
# Run from videoseal/ repo root (cwd-relative configs): python ../convert_tflite.py
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))

import litert_torch  # noqa: E402
import videoseal  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')


class EmbedderWrapper(torch.nn.Module):
    # Fixed-shape wrapper: TFLite wants static shapes and a single forward
    def __init__(self, embedder):
        super().__init__()
        self.embedder = embedder

    def forward(self, frame, msg):
        return self.embedder(frame, msg)


def main():
    model = videoseal.load('videoseal')
    model.eval()
    wrapper = EmbedderWrapper(model.embedder).eval()

    chans = 1 if getattr(model.embedder, 'yuv', False) else 3
    frame = torch.rand(1, chans, 256, 256)
    msg = torch.randint(0, 2, (1, 256)).float()

    with torch.no_grad():
        ref = wrapper(frame, msg)

    edge = litert_torch.convert(wrapper, (frame, msg))
    out = edge(frame, msg)

    # Numerical sanity vs PyTorch
    diff = (torch.tensor(out) - ref).abs().max().item()
    print(f'max abs diff vs pytorch: {diff:.2e}')

    path = os.path.join(OUT, 'embedder_fp32.tflite')
    edge.export(path)
    print(f'saved {path} ({os.path.getsize(path) / 1e6:.1f}MB)')


if __name__ == '__main__':
    main()
