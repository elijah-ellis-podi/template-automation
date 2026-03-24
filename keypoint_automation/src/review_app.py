"""
Streamlit review UI for flagged keypoint predictions.

Run with:
  streamlit run src/review_app.py -- --output-dir pipeline_output/

Reviewer workflow:
  1. Select a flagged patient/side from the sidebar
  2. See the thermogram with predicted keypoints overlaid
  3. Optionally adjust keypoint positions using number inputs
  4. Click Accept or Correct & Accept
"""

import sys
import pathlib
import argparse
import json

import numpy as np
import streamlit as st
from PIL import Image
import io

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import KEYPOINT_NAMES, load_patient
from visualize import render_with_keypoints, template_to_rgb
import review_queue as rq

# ── Parse output-dir from command line (streamlit passes args after '--') ──
_parser = argparse.ArgumentParser(add_help=False)
_parser.add_argument('--output-dir', type=str, default='pipeline_output')
_args, _ = _parser.parse_known_args()
OUTPUT_DIR = pathlib.Path(_args.output_dir)


def _load_queue():
    return rq.load_queue(OUTPUT_DIR)


def _render_item(item: dict) -> Image.Image:
    """Render the thermogram with predicted keypoints for a review item."""
    patient_id = item['patient_id']
    side = item['side']

    # Load template (we use the stored template for display; in
    # production this would be the best aligned scan thermogram)
    try:
        patient = load_patient(patient_id)
        template = patient[f'{side}_template']
    except Exception:
        # Fallback: blank image
        template = np.zeros((128, 64), dtype=np.float32)

    coords_raw = item.get('predicted_coords')
    if coords_raw:
        coords = np.array(coords_raw)
    else:
        coords = np.full((6, 2), np.nan)

    rgb = render_with_keypoints(
        template, coords, KEYPOINT_NAMES,
        title=f'{patient_id[:8]}… {side} — predicted',
        colormap='hot',
    )
    return Image.fromarray(rgb)


# ── Streamlit app ──────────────────────────────────────────────────────────

st.set_page_config(page_title='Keypoint Review', layout='wide')
st.title('Keypoint Review Queue')

queue = _load_queue()
if not queue:
    st.info('No items in the review queue. Run `scan_pipeline.py` first.')
    st.stop()

pending  = [x for x in queue if not x['reviewed']]
reviewed = [x for x in queue if x['reviewed']]

st.sidebar.header('Queue Status')
st.sidebar.metric('Total items',    len(queue))
st.sidebar.metric('Pending review', len(pending))
st.sidebar.metric('Reviewed',       len(reviewed))

if not pending:
    st.success('All items reviewed!')
    st.stop()

progress = len(reviewed) / len(queue)
st.progress(progress, text=f'{len(reviewed)} / {len(queue)} reviewed')

# ── Select item ──
labels = [
    f"{x['patient_id'][:10]}… · {x['side']} · {x['confidence']} "
    f"(n={x['n_scans_used']}, q={x['mean_quality']:.2f})"
    for x in pending
]
selected_idx = st.sidebar.selectbox('Select patient to review', range(len(pending)),
                                    format_func=lambda i: labels[i])
item = pending[selected_idx]

# ── Layout: image left, controls right ──
col_img, col_controls = st.columns([2, 3])

with col_img:
    st.subheader(f"{item['patient_id'][:12]}… — {item['side'].upper()} foot")
    img = _render_item(item)
    st.image(img, use_container_width=True)

    # Info
    st.caption(f"Confidence: **{item['confidence']}** | "
               f"Scans used: {item['n_scans_used']} | "
               f"Mean quality: {item['mean_quality']:.2f}")
    if item.get('flagged_keypoints'):
        st.warning(f"High variance: {', '.join(item['flagged_keypoints'])}")

with col_controls:
    st.subheader('Keypoint coordinates')
    st.caption('Review predicted (x, y) values. Adjust if incorrect.')

    coords_raw = item.get('predicted_coords') or [[0.5, 0.5]] * 6
    coords = np.array(coords_raw)

    corrected = []
    for i, name in enumerate(KEYPOINT_NAMES):
        flagged = name in (item.get('flagged_keypoints') or [])
        label = f'**{name}**' if flagged else name
        c1, c2 = st.columns(2)
        x_val = float(coords[i, 0]) if not np.isnan(coords[i, 0]) else 0.5
        y_val = float(coords[i, 1]) if not np.isnan(coords[i, 1]) else 0.5
        with c1:
            x = st.number_input(f'{name} x', min_value=0.0, max_value=1.0,
                                value=x_val, step=0.005, format='%.3f',
                                key=f'x_{i}')
        with c2:
            y = st.number_input(f'{name} y', min_value=0.0, max_value=1.0,
                                value=y_val, step=0.005, format='%.3f',
                                key=f'y_{i}')
        corrected.append([x, y])

    st.divider()
    col_a, col_b = st.columns(2)

    with col_a:
        if st.button('✓ Accept as-is', use_container_width=True, type='secondary'):
            rq.accept(item['patient_id'], item['side'], OUTPUT_DIR)
            st.success('Accepted!')
            st.rerun()

    with col_b:
        if st.button('✏️ Correct & Accept', use_container_width=True, type='primary'):
            rq.submit_correction(item['patient_id'], item['side'],
                                 corrected, OUTPUT_DIR)
            st.success('Correction saved!')
            st.rerun()

# ── Show previously reviewed ──
if reviewed:
    with st.expander(f'Reviewed items ({len(reviewed)})'):
        for r in reviewed:
            accepted_mark = '✓' if r.get('accepted') else '✗'
            st.write(
                f"{accepted_mark} `{r['patient_id'][:12]}…` · {r['side']} · "
                f"{r['confidence']}"
            )
