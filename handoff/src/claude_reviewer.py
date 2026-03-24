"""
Claude Vision reviewer for predicted keypoints.

Called only when the anatomical validator score < 0.9.  Sends one image
(smooth foot template with predicted keypoints overlaid) to Claude and gets back
a per-keypoint review with confidence score.

Differences from claude_keypoints.py (predictor):
  - No few-shot example images  → saves ~18k tokens per call
  - Claude reviews, not predicts → shorter output (text, not coordinates)
  - Uses claude-haiku for cost efficiency (~$0.003/call vs $0.042)
  - Returns ReviewResult with per-keypoint status and issues

Pricing (claude-haiku-4-5):
  $0.80/MTok input + $4.00/MTok output  →  ~$0.001-0.003 per call
"""

import json
import re
from dataclasses import dataclass, field
from typing import Optional, List, Dict
import numpy as np
import anthropic

import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from data_loader import KEYPOINT_NAMES
from visualize import render_with_keypoints, to_base64_png

MODEL = 'claude-haiku-4-5-20251001'

_PRICE_INPUT_PER_MTOK  = 0.80
_PRICE_OUTPUT_PER_MTOK = 4.00

_usage = {'input_tokens': 0, 'output_tokens': 0, 'calls': 0}


def get_usage() -> dict:
    """Return cumulative token usage since process start."""
    inp  = _usage['input_tokens']
    out  = _usage['output_tokens']
    cost = (inp * _PRICE_INPUT_PER_MTOK + out * _PRICE_OUTPUT_PER_MTOK) / 1_000_000
    return dict(calls=_usage['calls'], input_tokens=inp, output_tokens=out,
                estimated_cost_usd=round(cost, 4))


@dataclass
class KeypointReview:
    status: str          # 'correct' | 'wrong' | 'uncertain'
    issue: str = ''      # description of the problem (empty if correct)


@dataclass
class ReviewResult:
    overall_confidence: float                        # 0–1
    keypoints: Dict[str, KeypointReview]             # per-keypoint review
    accept: bool                                     # True if confidence ≥ 0.8 and no 'wrong'
    raw_response: str = ''                           # raw Claude text for debugging


SYSTEM_PROMPT = """\
You are a podiatric anatomy expert reviewing predicted keypoint placements on a smooth
foot thermography template image.

The image shows a foot template (grayscale heatmap, toes at top, heel at bottom) with
6 predicted keypoint markers overlaid as colored dots with labels.

The 6 keypoints are:
  Hallux               – tip of the big toe; should be near the top of the foot,
                         on the medial side (right side of image for a right foot,
                         left side for a left foot)
  1st Metatarsal Head  – base of big toe; medial forefoot bulge, below Hallux
  3rd Metatarsal Head  – centre of the widest forefoot band
  5th Metatarsal Head  – base of little toe; lateral forefoot bulge
  Arch                 – medial concave indentation at midfoot; should be on the
                         medial edge of the foot, between the metatarsal heads and heel
  Heel                 – centre of the heel pad at the very bottom

Your task: for each keypoint, decide if it is correctly placed.
Return ONLY a JSON object (no markdown fences) with this schema:
{
  "overall_confidence": <0.0–1.0 float>,
  "keypoints": {
    "<name>": {"status": "correct" | "wrong" | "uncertain", "issue": "<brief description or empty>"},
    ...
  }
}

overall_confidence: your overall confidence that all keypoints are correctly placed.
  1.0 = all clearly correct, 0.0 = major errors throughout.
Be concise — issues should be one short phrase (e.g. "too lateral", "in heel zone").
"""


def review_keypoints(
    template: np.ndarray,
    coords: np.ndarray,
    side: str,
    client: Optional[anthropic.Anthropic] = None,
    validator_violations: Optional[List[str]] = None,
) -> ReviewResult:
    """
    Ask Claude to review predicted keypoints overlaid on a foot template.

    Parameters
    ----------
    template             : smooth 2D float template array (e.g. from feet.json)
    coords               : (6, 2) predicted normalized (x, y) keypoints
    side                 : 'left' or 'right'
    client               : optional pre-built Anthropic client
    validator_violations : list of anatomical rule violations from anatomical_validator
                           (prepended to the user message for context)

    Returns
    -------
    ReviewResult
    """
    if client is None:
        client = anthropic.Anthropic()

    # Render template with predicted keypoints overlaid
    rgb = render_with_keypoints(
        template, coords, KEYPOINT_NAMES,
        title=f'Predicted keypoints — {side} foot',
        colormap='hot',
    )
    b64 = to_base64_png(rgb)

    # Build user message
    violation_text = ''
    if validator_violations:
        violation_text = (
            '\n\nThe anatomical rule checker flagged these potential issues:\n'
            + '\n'.join(f'  - {v}' for v in validator_violations)
            + '\n\nPlease check these specifically.\n'
        )

    user_content = [
        {
            'type': 'text',
            'text': (
                f'Review the predicted keypoints on this {side} foot template.'
                f'{violation_text}'
                '\nFor each keypoint say if it is correctly placed. Return the JSON.'
            )
        },
        {
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': 'image/png',
                'data': b64,
            }
        },
    ]

    message = client.messages.create(
        model=MODEL,
        max_tokens=512,
        system=SYSTEM_PROMPT,
        messages=[{'role': 'user', 'content': user_content}],
    )

    if hasattr(message, 'usage'):
        _usage['input_tokens']  += message.usage.input_tokens
        _usage['output_tokens'] += message.usage.output_tokens
        _usage['calls'] += 1

    raw = message.content[0].text.strip()
    return _parse_response(raw)


def _parse_response(raw: str) -> ReviewResult:
    """Parse Claude's JSON review response."""
    # Strip markdown fences
    raw_clean = re.sub(r'^```[a-z]*\n?', '', raw, flags=re.MULTILINE)
    raw_clean = re.sub(r'```$', '', raw_clean, flags=re.MULTILINE).strip()

    try:
        data = json.loads(raw_clean)
    except json.JSONDecodeError:
        m = re.search(r'\{.*\}', raw_clean, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group())
            except json.JSONDecodeError:
                return _fallback_result(raw)
        else:
            return _fallback_result(raw)

    confidence = float(data.get('overall_confidence', 0.5))
    kp_data = data.get('keypoints', {})

    keypoints: Dict[str, KeypointReview] = {}
    has_wrong = False
    for name in KEYPOINT_NAMES:
        entry = kp_data.get(name, {})
        status = str(entry.get('status', 'uncertain')).lower()
        issue  = str(entry.get('issue', ''))
        if status not in ('correct', 'wrong', 'uncertain'):
            status = 'uncertain'
        if status == 'wrong':
            has_wrong = True
        keypoints[name] = KeypointReview(status=status, issue=issue)

    accept = confidence >= 0.8 and not has_wrong

    return ReviewResult(
        overall_confidence=confidence,
        keypoints=keypoints,
        accept=accept,
        raw_response=raw,
    )


def _fallback_result(raw: str) -> ReviewResult:
    """Return a conservative uncertain result when parsing fails."""
    return ReviewResult(
        overall_confidence=0.5,
        keypoints={name: KeypointReview(status='uncertain', issue='parse error')
                   for name in KEYPOINT_NAMES},
        accept=False,
        raw_response=raw,
    )
