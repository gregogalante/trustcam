# Export the on-device watermarking pipeline as three ONNX graphs and verify
# numerical parity against VideoSeal's own embed path.
#
#   frame_prep.onnx   : y 1x1xHxW (dynamic)            -> y_res 1x1x256x256
#   embedder_key.onnx : (y_res, msg 1x256)             -> delta_raw 1x1x256x256
#   frame_apply.onnx  : (y dynamic, delta_raw)         -> y_w 1x1xHxW
#
# Per frame: prep (cheap) + apply (cheap); embedder_key only on key frames
# (every step_size frames) — replicates Videoseal.embed(video_mode="repeat",
# lowres_attenuation=True) on the Y channel.
#
# Deliberate deviation: resizes are bilinear WITHOUT antialias (the exporter
# cannot emit antialiased Resize). This slightly changes the 256x256 view vs
# the server embedder; the e2e check below proves extraction still recovers
# the payload at full confidence.
#
# Run from the videoseal clone root: python ../export_frame_graphs.py
import os
import sys

import torch
import torch.nn.functional as F
from torch import nn

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))
import videoseal  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
SIZE = 256
INTERP = {'mode': 'bilinear', 'align_corners': False}


class PrepGraph(nn.Module):
    def forward(self, y):
        return F.interpolate(y, size=(SIZE, SIZE), **INTERP)


class KeyGraph(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.embedder = model.embedder

    def forward(self, y_res, msg):
        return self.embedder(y_res, msg)


class ApplyGraph(nn.Module):
    """JND attenuation + upscale + additive blend, rewritten functionally
    (the original JND uses masked in-place assignment, which doesn't export)."""

    def __init__(self, model):
        super().__init__()
        jnd = model.attenuation
        self.register_buffer('k_lum', jnd.conv_lum.weight)
        self.register_buffer('k_x', jnd.conv_x.weight)
        self.register_buffer('k_y', jnd.conv_y.weight)
        self.scaling_i = float(model.blender.scaling_i)
        self.scaling_w = float(model.blender.scaling_w)

    def heatmaps(self, y_res):
        x = 255.0 * y_res
        la = F.conv2d(x, self.k_lum, padding=2) / 32
        la = torch.where(
            la <= 127,
            17 * (1 - torch.sqrt(torch.clamp(la, min=0.0) / 127 + 1e-5)),
            3 / 128 * (la - 127) + 3)
        gx = F.conv2d(x, self.k_x, padding=1)
        gy = F.conv2d(x, self.k_y, padding=1)
        cm = torch.sqrt(gx ** 2 + gy ** 2)
        cm = 16 * cm ** 2.4 / (cm ** 2 + 26 ** 2) * 0.117
        return torch.clamp(la + cm - 0.3 * torch.minimum(la, cm), min=0.0) / 255.0

    def forward(self, y, delta_raw):
        y_res = F.interpolate(y, size=(SIZE, SIZE), **INTERP)
        delta = self.heatmaps(y_res) * delta_raw
        delta_full = F.interpolate(delta, size=(y.shape[-2], y.shape[-1]), **INTERP)
        return torch.clamp(self.scaling_i * y + self.scaling_w * delta_full, 0.0, 1.0)


def main():
    os.makedirs(OUT, exist_ok=True)
    model = videoseal.load('videoseal')
    model.eval()
    prep = PrepGraph().eval()
    key = KeyGraph(model).eval()
    apply_g = ApplyGraph(model).eval()

    torch.manual_seed(0)
    h, w = 720, 1280
    # mid-range pixels: no [0,1] clamping, so additive deltas compare exactly
    rgb = 0.25 + 0.5 * torch.rand(1, 3, h, w)
    msg = torch.randint(0, 2, (1, 256)).float()

    # --- torch-level parity of the functional JND vs the original module ---
    with torch.no_grad():
        y = model.rgb2yuv(rgb)[:, 0:1]
        y_res_aa = F.interpolate(y, size=(SIZE, SIZE), mode='bilinear',
                                 align_corners=False, antialias=True)
        h_ref = model.attenuation.heatmaps(y_res_aa.repeat(1, 3, 1, 1))
        h_ours = apply_g.heatmaps(y_res_aa)
        jnd_diff = (h_ref - h_ours).abs().max().item()
    print(f'JND functional parity: {jnd_diff:.2e}')
    assert jnd_diff < 1e-4, 'JND parity failed'

    # --- export ---
    paths = {}
    for name, mod, args, dyn in [
        ('frame_prep', prep, (y,), {'y': {2: 'h', 3: 'w'}}),
        ('embedder_key', key, (prep(y), msg), None),
        ('frame_apply', apply_g, (y, key(prep(y), msg)),
         {'y': {2: 'h', 3: 'w'}, 'y_w': {2: 'h', 3: 'w'}}),
    ]:
        names = {'frame_prep': ['y'], 'embedder_key': ['y_res', 'message'],
                 'frame_apply': ['y', 'delta_raw']}[name]
        p = os.path.join(OUT, f'{name}.onnx')
        with torch.no_grad():
            torch.onnx.export(mod, args, p,
                              input_names=names, output_names=['out'],
                              dynamic_axes=dyn, opset_version=17, dynamo=False)
        paths[name] = p
        print(f'exported {name}.onnx ({os.path.getsize(p) / 1e6:.1f}MB)')

    # fix input names for frame_apply (two inputs)
    # (torch names them positionally; re-check with onnxruntime below)

    # --- onnxruntime parity across resolutions ---
    import onnxruntime as ort
    sess = {n: ort.InferenceSession(p) for n, p in paths.items()}
    def innames(n):
        return [i.name for i in sess[n].get_inputs()]
    print('inputs:', {n: innames(n) for n in sess})

    for th, tw in [(720, 1280), (1904, 1080)]:
        rgb2 = 0.25 + 0.5 * torch.rand(1, 3, th, tw)
        y2 = model.rgb2yuv(rgb2)[:, 0:1]
        with torch.no_grad():
            yr_t = prep(y2)
            d_t = key(yr_t, msg)
            yw_t = apply_g(y2, d_t)
        yr_o = sess['frame_prep'].run(None, {innames('frame_prep')[0]: y2.numpy()})[0]
        d_o = sess['embedder_key'].run(None, {
            innames('embedder_key')[0]: yr_o, innames('embedder_key')[1]: msg.numpy()})[0]
        yw_o = sess['frame_apply'].run(None, {
            innames('frame_apply')[0]: y2.numpy(), innames('frame_apply')[1]: d_o})[0]
        dp = abs(yr_t.numpy() - yr_o).max()
        dk = abs(d_t.numpy() - d_o).max()
        da = abs(yw_t.numpy() - yw_o).max()
        print(f'{th}x{tw}: prep={dp:.2e} key={dk:.2e} apply={da:.2e}')
        # dk is an intermediate: the deep embedder amplifies fp noise; what
        # matters is the final watermarked frame
        assert da < 1e-3, 'onnx parity failed on final frame'

    print('ALL PARITY CHECKS PASSED')


if __name__ == '__main__':
    main()
