"""
Lightweight supervised keypoint regressor trained on the 20 labeled patients.

Architecture
------------
Ridge regression on histogram-of-oriented-gradients (HOG) features extracted
from the resized smooth template.  HOG captures shape structure well and is
robust for small datasets.

Training
--------
Leave-one-out cross-validation (LOO-CV) is used during evaluation so every
patient gets a prediction from a model it was NOT trained on.

The `fit()` function returns a trained model object that `predict()` accepts.
During evaluation, `fit_and_predict_loo()` handles the LOO loop.
"""

from typing import List, Tuple
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from skimage.transform import resize
from skimage.feature import hog

import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))

from data_loader import KEYPOINT_NAMES

# Canonical size for the resized template before feature extraction
CANONICAL_SHAPE = (128, 64)   # (rows, cols) = (height, width)


def _extract_features(template: np.ndarray) -> np.ndarray:
    """
    Resize template to CANONICAL_SHAPE, normalise, and compute HOG features.
    Returns 1D float64 feature vector.
    """
    # Resize with anti-aliasing
    img = resize(template, CANONICAL_SHAPE, anti_aliasing=True)
    # Normalise to [0, 1]
    vmin, vmax = img.min(), img.max()
    if vmax > vmin:
        img = (img - vmin) / (vmax - vmin)

    features = hog(
        img,
        orientations=9,
        pixels_per_cell=(8, 8),
        cells_per_block=(2, 2),
        block_norm='L2-Hys',
        feature_vector=True,
    )
    return features


def build_dataset(
    templates: List[np.ndarray],
    keypoint_arrays: List[np.ndarray],
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Build X (N, F) feature matrix and Y (N, 12) target matrix.
    Patients with any NaN keypoints are excluded.
    Returns indices of kept patients too.
    """
    X_rows, Y_rows, kept = [], [], []
    for i, (tmpl, kp) in enumerate(zip(templates, keypoint_arrays)):
        if np.any(np.isnan(kp)):
            continue
        X_rows.append(_extract_features(tmpl))
        Y_rows.append(kp.flatten())   # (6, 2) → (12,)
        kept.append(i)
    X = np.array(X_rows)
    Y = np.array(Y_rows)
    return X, Y, kept


def fit(
    templates: List[np.ndarray],
    keypoint_arrays: List[np.ndarray],
    alpha: float = 1.0,
) -> Pipeline:
    """
    Train a Ridge regressor on all provided (template, keypoints) pairs.
    Returns a fitted sklearn Pipeline.
    """
    X, Y, _ = build_dataset(templates, keypoint_arrays)
    if len(X) == 0:
        raise ValueError('No valid training samples')
    model = Pipeline([
        ('scaler', StandardScaler()),
        ('ridge', Ridge(alpha=alpha)),
    ])
    model.fit(X, Y)
    return model


def predict(model: Pipeline, template: np.ndarray) -> np.ndarray:
    """
    Predict keypoints for a single template.
    Returns (6, 2) float array of normalised (x, y) coords.
    Values are clipped to [0, 1].
    """
    feats = _extract_features(template).reshape(1, -1)
    y_pred = model.predict(feats)[0]          # (12,)
    coords = y_pred.reshape(6, 2)
    return np.clip(coords, 0.0, 1.0)


def fit_and_predict_loo(
    templates: List[np.ndarray],
    keypoint_arrays: List[np.ndarray],
    alpha: float = 1.0,
) -> List[np.ndarray]:
    """
    Leave-one-out cross-validation.

    Returns a list of (6, 2) predictions, one per input patient (in the same
    order as templates/keypoint_arrays).  Patients with NaN keypoints are
    returned as NaN arrays.
    """
    N = len(templates)
    predictions = [np.full((6, 2), np.nan) for _ in range(N)]

    X_all, Y_all, kept = build_dataset(templates, keypoint_arrays)
    if len(kept) < 3:
        return predictions   # too few samples

    for lo_idx in range(len(kept)):
        train_X = np.delete(X_all, lo_idx, axis=0)
        train_Y = np.delete(Y_all, lo_idx, axis=0)
        if len(train_X) == 0:
            continue
        model = Pipeline([
            ('scaler', StandardScaler()),
            ('ridge', Ridge(alpha=alpha)),
        ])
        model.fit(train_X, train_Y)
        pred_flat = model.predict(X_all[lo_idx:lo_idx+1])[0]
        coords = np.clip(pred_flat.reshape(6, 2), 0.0, 1.0)
        predictions[kept[lo_idx]] = coords

    return predictions
