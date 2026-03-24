"""
Render a foot template array as a false-color thermal image suitable for
the Claude Vision API and for saving diagnostic figures.
"""

import io
import base64
from typing import List
import numpy as np
from PIL import Image
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.cm as cm


# Scale factor: upscale the small template before sending to Claude
RENDER_SCALE = 4


def template_to_rgb(template: np.ndarray, colormap: str = 'hot') -> np.ndarray:
    """
    Normalise template to [0,1] and apply a matplotlib colormap.
    Returns (H*scale, W*scale, 3) uint8 RGB array.
    """
    cmap = cm.get_cmap(colormap)
    vmin, vmax = template.min(), template.max()
    if vmax > vmin:
        norm = (template - vmin) / (vmax - vmin)
    else:
        norm = np.zeros_like(template)
    rgba = cmap(norm)                          # (H, W, 4)
    rgb = (rgba[:, :, :3] * 255).astype(np.uint8)

    # upscale with nearest-neighbour to keep pixel edges crisp
    h, w = rgb.shape[:2]
    img = Image.fromarray(rgb).resize(
        (w * RENDER_SCALE, h * RENDER_SCALE), resample=Image.NEAREST
    )
    return np.array(img)


def render_with_keypoints(
    template: np.ndarray,
    keypoints_xy: np.ndarray,
    keypoint_names: List[str],
    title: str = '',
    colormap: str = 'hot',
) -> np.ndarray:
    """
    Render template with keypoint dots overlaid.
    keypoints_xy: (N, 2) normalised (x, y) coords; NaN values are skipped.
    Returns (H, W, 3) uint8 RGB array.
    """
    rgb = template_to_rgb(template, colormap=colormap)
    h, w = rgb.shape[:2]

    fig, ax = plt.subplots(figsize=(w / 80, h / 80), dpi=80)
    ax.imshow(rgb)
    ax.axis('off')
    if title:
        ax.set_title(title, fontsize=8)

    colors = plt.cm.tab10(np.linspace(0, 1, len(keypoint_names)))
    for i, (name, (x, y)) in enumerate(zip(keypoint_names, keypoints_xy)):
        if np.isnan(x) or np.isnan(y):
            continue
        px, py = x * w, y * h
        ax.plot(px, py, 'o', color=colors[i], markersize=6, markeredgecolor='white',
                markeredgewidth=0.8)
        ax.annotate(name[:4], (px, py), fontsize=5, color='white',
                    xytext=(3, 3), textcoords='offset points')

    buf = io.BytesIO()
    fig.savefig(buf, format='png', bbox_inches='tight', pad_inches=0.05, dpi=80)
    plt.close(fig)
    buf.seek(0)
    return np.array(Image.open(buf).convert('RGB'))


def to_png_bytes(rgb: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format='PNG')
    return buf.getvalue()


def to_base64_png(rgb: np.ndarray) -> str:
    return base64.standard_b64encode(to_png_bytes(rgb)).decode('utf-8')


def save_image(rgb: np.ndarray, path: str):
    Image.fromarray(rgb).save(path)
