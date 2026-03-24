"""
Keypoint detection via Claude Vision API (few-shot).

Strategy
--------
1. Select 2 example patients from the dataset (held out from evaluation).
2. Render each as an annotated image (keypoint dots + labels).
3. For the target patient, render the plain thermogram image.
4. Send all three images in a single multi-turn-style message to Claude
   and ask it to return JSON with pixel coordinates.
5. Convert pixel coords back to normalised (x, y).
"""

import json
import re
import os
from typing import Optional, List
import numpy as np
import anthropic

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import KEYPOINT_NAMES, load_patient, get_keypoint_array, all_patient_ids
from visualize import render_with_keypoints, template_to_rgb, to_base64_png

# These two patients are used ONLY as few-shot examples and are excluded
# from the evaluation loop.
FEW_SHOT_PATIENT_IDS = [
    '072bc0ef886c2b0b9608bcf2b0f634bd',
    '171dfdfd3d9ae43f66ff0b774e7f7acc',
]

MODEL = 'claude-opus-4-6'

SYSTEM_PROMPT = """You are an expert medical imaging analyst specialising in
podiatric thermography.  You will be shown foot thermogram template images and
must locate 6 anatomical landmarks on each foot.

The 6 landmarks (in order) are:
  1. Hallux          – tip/ball of the big toe
  2. 1st Metatarsal Head – medial forefoot, at the base of the big toe
  3. 3rd Metatarsal Head – centre forefoot, widest area of the ball
  4. 5th Metatarsal Head – lateral forefoot, at the base of the little toe
  5. Arch            – midfoot, on the concave (arch) side
  6. Heel            – centre of the heel/calcaneus

Images are oriented with TOES at the TOP and HEEL at the BOTTOM.
For a RIGHT foot the big toe (Hallux) is on the RIGHT side of the image.
For a LEFT  foot the big toe (Hallux) is on the LEFT  side of the image.

Return ONLY a valid JSON object (no markdown fences) with this exact schema:
{
  "Hallux":               {"x": <0-1 float>, "y": <0-1 float>},
  "1st Metatarsal Head":  {"x": <0-1 float>, "y": <0-1 float>},
  "3rd Metatarsal Head":  {"x": <0-1 float>, "y": <0-1 float>},
  "5th Metatarsal Head":  {"x": <0-1 float>, "y": <0-1 float>},
  "Arch":                 {"x": <0-1 float>, "y": <0-1 float>},
  "Heel":                 {"x": <0-1 float>, "y": <0-1 float>}
}

x = 0.0 is the LEFT edge of the image, x = 1.0 is the RIGHT edge.
y = 0.0 is the TOP  of the image (toes), y = 1.0 is the BOTTOM (heel).
All values must be between 0.0 and 1.0.
# """
# SYSTEM_PROMPT = """You are an expert medical imaging analyst specializing in podiatric thermography.

# You will be shown a foot thermogram template image. Your task is to:
# 1. Classify what the image contains
# 2. Locate up to 6 anatomical landmarks on each visible foot

# ═══════════════════════════════════════════════════
# STEP 1 — CLASSIFY THE IMAGE
# ═══════════════════════════════════════════════════

# Before placing any keypoints, determine:

# - **Foot count**: Is this a single foot or a pair (left + right)?
#   A single-foot image shows one isolated thermal footprint.
#   A pair shows two footprints side by side.

# - **Which foot** (for single-foot images): Identify left vs right using:
#   • The big toe (Hallux) is the LARGEST toe and sits on the MEDIAL side
#   • For a RIGHT foot: the big toe appears on the RIGHT side of the image
#   • For a LEFT foot: the big toe appears on the LEFT side of the image
#   • The arch concavity curves inward (toward the medial side)
#   • The 5th metatarsal (smallest toe base) is on the LATERAL (outer) side

# - **Completeness**: Is the foot intact or does it show signs of partial
#   amputation (e.g., missing toes, forefoot amputation, transmetatarsal
#   amputation)? Look for:
#   • Abrupt thermal boundary where anatomy should continue
#   • Missing toe structures at the forefoot
#   • Shortened foot silhouette compared to typical proportions
#   • Asymmetric thermal region (one side of forefoot missing)

# ═══════════════════════════════════════════════════
# STEP 2 — PLACE KEYPOINTS
# ═══════════════════════════════════════════════════

# The 6 landmarks (in anatomical proximal-to-distal order):

#   1. Hallux             – tip/center of the big toe pad
#   2. 1st Metatarsal Head – medial forefoot, base of the big toe
#   3. 3rd Metatarsal Head – center forefoot, widest point of the ball
#   4. 5th Metatarsal Head – lateral forefoot, base of the little toe
#   5. Arch               – midfoot, center of the concave arch region
#   6. Heel               – center of the calcaneus (heel pad)

# IMAGE ORIENTATION:
# - Toes at TOP, heel at BOTTOM
# - x = 0.0 is LEFT edge, x = 1.0 is RIGHT edge
# - y = 0.0 is TOP (toes), y = 1.0 is BOTTOM (heel)

# SPATIAL CONSISTENCY RULES (use these to self-check):
# - Hallux.y < 1st_Met.y  (toe tip is above its base)
# - 1st_Met.y ≈ 3rd_Met.y ≈ 5th_Met.y  (metatarsal heads form a roughly horizontal line)
# - All metatarsal heads.y < Arch.y < Heel.y  (forefoot → midfoot → rearfoot)
# - For a RIGHT foot: Hallux.x > 5th_Met.x  (big toe is right of little toe)
# - For a LEFT foot:  Hallux.x < 5th_Met.x  (big toe is left of little toe)
# - Heel.x ≈ midpoint between 1st_Met.x and 5th_Met.x  (heel is roughly centered)

# AMPUTATION / MISSING ANATOMY RULES:
# - If a landmark's anatomy is clearly absent (amputated toe, missing forefoot
#   region), set that keypoint to null — do NOT guess a position.
# - If a landmark's anatomy is present but partially obscured or ambiguous,
#   place your best estimate and set confidence below 0.5.
# - Common patterns:
#   • Hallux amputation → Hallux = null, metatarsal heads may still be present
#   • Transmetatarsal amputation → Hallux + all metatarsal heads = null
#   • Ray amputation (e.g., 5th ray) → 5th Metatarsal Head = null

# ═══════════════════════════════════════════════════
# OUTPUT FORMAT
# ═══════════════════════════════════════════════════

# Return ONLY a valid JSON object (no markdown fences, no commentary) with
# this exact schema:

# {
#   "image_classification": {
#     "foot_count": "single" | "pair",
#     "detected_feet": ["left"] | ["right"] | ["left", "right"],
#     "anomalies": "<string describing any amputation, deformity, or quality issues — or 'none'>"
#   },
#   "feet": {
#     "<left|right>": {
#       "Hallux":              {"x": <float 0-1>, "y": <float 0-1>, "confidence": <float 0-1>} | null,
#       "1st Metatarsal Head": {"x": <float 0-1>, "y": <float 0-1>, "confidence": <float 0-1>} | null,
#       "3rd Metatarsal Head": {"x": <float 0-1>, "y": <float 0-1>, "confidence": <float 0-1>} | null,
#       "5th Metatarsal Head": {"x": <float 0-1>, "y": <float 0-1>, "confidence": <float 0-1>} | null,
#       "Arch":                {"x": <float 0-1>, "y": <float 0-1>, "confidence": <float 0-1>} | null,
#       "Heel":                {"x": <float 0-1>, "y": <float 0-1>, "confidence": <float 0-1>} | null
#     }
#   }
# }

# For single-foot images, "feet" contains only one key ("left" or "right").
# For pairs, it contains both.
# A null keypoint means the anatomy is absent (amputation). Do not omit the
# key — always include all 6 landmark keys per foot, using null explicitly.

# All coordinate values must be between 0.0 and 1.0.
# Confidence: 1.0 = certain, 0.0 = pure guess. Below 0.3 = unreliable.
# """


def _build_few_shot_messages(side: str) -> List[dict]:
    """
    Build the few-shot example content blocks.
    Returns a list of content items to prepend to the user message.
    """
    content = []
    for pid in FEW_SHOT_PATIENT_IDS:
        try:
            patient = load_patient(pid)
        except Exception:
            continue
        template = patient[f'{side}_template']
        gt_coords = get_keypoint_array(patient['keypoints'], side)

        annotated_rgb = render_with_keypoints(
            template, gt_coords, KEYPOINT_NAMES,
            title=f'Example ({side} foot) – ground truth keypoints shown',
            colormap='hot',
        )
        b64 = to_base64_png(annotated_rgb)

        # Build the annotated ground-truth JSON for this example
        gt_json = {}
        for i, name in enumerate(KEYPOINT_NAMES):
            x, y = gt_coords[i]
            if not (np.isnan(x) or np.isnan(y)):
                gt_json[name] = {'x': round(float(x), 4), 'y': round(float(y), 4)}

        content.append({
            'type': 'text',
            'text': f'Example {side} foot thermogram with correct keypoint annotations:'
        })
        content.append({
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': 'image/png',
                'data': b64,
            }
        })
        content.append({
            'type': 'text',
            'text': f'Correct answer for the above example:\n{json.dumps(gt_json, indent=2)}'
        })
    return content


def predict_keypoints(
    template: np.ndarray,
    side: str,
    client: Optional[anthropic.Anthropic] = None,
) -> np.ndarray:
    """
    Use Claude Vision API (few-shot) to predict keypoints.

    Parameters
    ----------
    template : 2D float array  (the smooth foot template)
    side     : 'left' or 'right'
    client   : optional pre-built Anthropic client

    Returns
    -------
    coords : (6, 2) float array of normalised (x, y) in KEYPOINT_NAMES order.
             Entries are NaN if Claude failed to provide a valid prediction.
    """
    if client is None:
        client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env

    target_rgb = template_to_rgb(template, colormap='hot')
    target_b64 = to_base64_png(target_rgb)

    few_shot = _build_few_shot_messages(side)

    user_content = few_shot + [
        {
            'type': 'text',
            'text': (
                f'Now locate the 6 keypoints on this NEW {side} foot thermogram. '
                'Return only the JSON object.'
            )
        },
        {
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': 'image/png',
                'data': target_b64,
            }
        }
    ]

    message = client.messages.create(
        model=MODEL,
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[{'role': 'user', 'content': user_content}],
    )

    raw = message.content[0].text.strip()
    return _parse_response(raw)


def predict_keypoints_full(
    template: np.ndarray,
    side: str,
    client: Optional[anthropic.Anthropic] = None,
) -> dict:
    """
    Like predict_keypoints but returns the full structured response dict
    with image_classification, per-keypoint confidence, and null support.

    Returns
    -------
    dict with keys: image_classification, feet
    """
    if client is None:
        client = anthropic.Anthropic()

    target_rgb = template_to_rgb(template, colormap='hot')
    target_b64 = to_base64_png(target_rgb)

    few_shot = _build_few_shot_messages(side)

    user_content = few_shot + [
        {
            'type': 'text',
            'text': (
                f'Now locate the 6 keypoints on this NEW {side} foot thermogram. '
                'Return only the JSON object.'
            )
        },
        {
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': 'image/png',
                'data': target_b64,
            }
        }
    ]

    message = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{'role': 'user', 'content': user_content}],
    )

    raw = message.content[0].text.strip()
    return _parse_response_full(raw, side)


def _parse_response_full(raw: str, side: str) -> dict:
    """Parse the new structured Claude response with image_classification + feet + confidence."""
    raw = re.sub(r'^```[a-z]*\n?', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'```$', '', raw, flags=re.MULTILINE).strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group())
            except json.JSONDecodeError:
                # Return empty structure
                return {'image_classification': None, 'feet': {side: {}}}
        else:
            return {'image_classification': None, 'feet': {side: {}}}

    # New format: { image_classification, feet: { left: {...}, right: {...} } }
    if 'feet' in data:
        return data

    # Legacy flat format: { "Hallux": {x, y}, ... } — wrap it
    foot_data = {}
    for name in KEYPOINT_NAMES:
        entry = data.get(name)
        if entry is None:
            foot_data[name] = None
        elif isinstance(entry, dict) and 'x' in entry and 'y' in entry:
            try:
                x, y = float(entry['x']), float(entry['y'])
                conf = float(entry['confidence']) if 'confidence' in entry else None
                if 0 <= x <= 1 and 0 <= y <= 1:
                    kp_entry = {'x': x, 'y': y}
                    if conf is not None:
                        kp_entry['confidence'] = conf
                    foot_data[name] = kp_entry
                else:
                    foot_data[name] = None
            except (TypeError, ValueError):
                foot_data[name] = None
        else:
            foot_data[name] = None

    return {
        'image_classification': data.get('image_classification'),
        'feet': {side: foot_data},
    }


def _parse_response(raw: str) -> np.ndarray:
    """Parse Claude's JSON response into a (6, 2) float array (legacy compat)."""
    coords = np.full((len(KEYPOINT_NAMES), 2), np.nan)

    raw = re.sub(r'^```[a-z]*\n?', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'```$', '', raw, flags=re.MULTILINE).strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group())
            except json.JSONDecodeError:
                return coords
        else:
            return coords

    # Handle new format
    if 'feet' in data:
        for side_data in data.get('feet', {}).values():
            for i, name in enumerate(KEYPOINT_NAMES):
                entry = side_data.get(name)
                if entry and isinstance(entry, dict) and 'x' in entry:
                    try:
                        coords[i] = [float(entry['x']), float(entry['y'])]
                    except (TypeError, ValueError):
                        pass
            break  # just take the first side
        return coords

    # Legacy flat format
    for i, name in enumerate(KEYPOINT_NAMES):
        entry = data.get(name)
        if entry and 'x' in entry and 'y' in entry:
            try:
                x, y = float(entry['x']), float(entry['y'])
                if 0 <= x <= 1 and 0 <= y <= 1:
                    coords[i] = [x, y]
            except (TypeError, ValueError):
                pass
    return coords
