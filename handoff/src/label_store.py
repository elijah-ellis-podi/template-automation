"""
SQLite store for human keypoint corrections and model evaluations.

Used by the active learning loop: corrections accumulate here, and
active_learner.maybe_retrain() reads them to augment the training set.

No third-party dependencies — uses stdlib sqlite3 only.

Schema
------
corrections
  patient_id      TEXT
  side            TEXT       'left' | 'right'
  keypoint_name   TEXT       e.g. 'Hallux'
  predicted_x     REAL
  predicted_y     REAL
  corrected_x     REAL
  corrected_y     REAL
  correction_magnitude  REAL  euclidean distance between predicted and corrected
  timestamp       TEXT       ISO-8601
  claude_issue    TEXT       Claude reviewer issue text (empty if no Claude review)
  trigger         TEXT       'human_qa' | 'bootstrap_failure' | 'synthetic'

model_evaluations
  version         TEXT       e.g. 'supervised_v20260324_142300'
  mean_error      REAL       normalized euclidean mean error from LOO-CV
  timestamp       TEXT       ISO-8601
  is_active       INTEGER    1 = currently deployed model
"""

import sqlite3
import pathlib
import json
from datetime import datetime, timezone
from typing import List, Optional, Tuple
import numpy as np


_DEFAULT_DB = pathlib.Path(__file__).parent.parent / 'pipeline_output' / 'label_store.db'


def _connect(db_path: pathlib.Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    _init_schema(conn)
    return conn


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS corrections (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id            TEXT NOT NULL,
            side                  TEXT NOT NULL,
            keypoint_name         TEXT NOT NULL,
            predicted_x           REAL,
            predicted_y           REAL,
            corrected_x           REAL NOT NULL,
            corrected_y           REAL NOT NULL,
            correction_magnitude  REAL,
            timestamp             TEXT NOT NULL,
            claude_issue          TEXT DEFAULT '',
            trigger               TEXT DEFAULT 'human_qa'
        );

        CREATE TABLE IF NOT EXISTS model_evaluations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            version     TEXT NOT NULL,
            mean_error  REAL NOT NULL,
            timestamp   TEXT NOT NULL,
            is_active   INTEGER DEFAULT 0
        );
    """)
    conn.commit()


def record_correction(
    patient_id: str,
    side: str,
    keypoint_name: str,
    predicted_xy: Optional[Tuple[float, float]],
    corrected_xy: Tuple[float, float],
    claude_issue: str = '',
    trigger: str = 'human_qa',
    db_path: pathlib.Path = _DEFAULT_DB,
) -> None:
    """
    Record a human correction for one keypoint.

    Parameters
    ----------
    patient_id    : patient identifier
    side          : 'left' or 'right'
    keypoint_name : KEYPOINT_NAMES entry
    predicted_xy  : (x, y) normalized — None if no prediction existed
    corrected_xy  : (x, y) normalized — the human-corrected position
    claude_issue  : Claude reviewer issue text ('' if no review was done)
    trigger       : reason for this correction
    db_path       : path to the SQLite database file
    """
    mag: Optional[float] = None
    if predicted_xy is not None:
        dx = corrected_xy[0] - predicted_xy[0]
        dy = corrected_xy[1] - predicted_xy[1]
        mag = float(np.sqrt(dx ** 2 + dy ** 2))

    pred_x = float(predicted_xy[0]) if predicted_xy else None
    pred_y = float(predicted_xy[1]) if predicted_xy else None
    ts = datetime.now(timezone.utc).isoformat()

    with _connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO corrections
              (patient_id, side, keypoint_name,
               predicted_x, predicted_y, corrected_x, corrected_y,
               correction_magnitude, timestamp, claude_issue, trigger)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (patient_id, side, keypoint_name,
             pred_x, pred_y,
             float(corrected_xy[0]), float(corrected_xy[1]),
             mag, ts, claude_issue, trigger),
        )
        conn.commit()


def count_unprocessed(
    db_path: pathlib.Path = _DEFAULT_DB,
) -> int:
    """Return number of corrections not yet used in a model retrain."""
    with _connect(db_path) as conn:
        # "unprocessed" = corrections newer than the latest model evaluation
        row = conn.execute(
            "SELECT MAX(timestamp) AS latest FROM model_evaluations"
        ).fetchone()
        latest_eval = row['latest'] if row and row['latest'] else '1970-01-01'
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM corrections WHERE timestamp > ?",
            (latest_eval,),
        ).fetchone()['n']
    return int(n)


def get_correction_frequency_per_keypoint(
    db_path: pathlib.Path = _DEFAULT_DB,
) -> dict:
    """Return {keypoint_name: count} sorted descending by correction frequency."""
    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT keypoint_name, COUNT(*) AS cnt
            FROM corrections
            GROUP BY keypoint_name
            ORDER BY cnt DESC
            """
        ).fetchall()
    return {r['keypoint_name']: r['cnt'] for r in rows}


def get_corrections_as_arrays(
    db_path: pathlib.Path = _DEFAULT_DB,
) -> List[dict]:
    """
    Return all corrections as a list of dicts with keys:
      patient_id, side, keypoint_name, corrected_xy (tuple), magnitude, claude_issue
    """
    with _connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT patient_id, side, keypoint_name,
                   corrected_x, corrected_y, correction_magnitude, claude_issue
            FROM corrections
            ORDER BY timestamp ASC
            """
        ).fetchall()
    return [
        dict(
            patient_id=r['patient_id'],
            side=r['side'],
            keypoint_name=r['keypoint_name'],
            corrected_xy=(r['corrected_x'], r['corrected_y']),
            magnitude=r['correction_magnitude'],
            claude_issue=r['claude_issue'],
        )
        for r in rows
    ]


def record_model_evaluation(
    version: str,
    mean_error: float,
    set_active: bool = False,
    db_path: pathlib.Path = _DEFAULT_DB,
) -> None:
    """
    Record a model evaluation result. If set_active=True, mark as the deployed model
    (and deactivate previous active version).
    """
    ts = datetime.now(timezone.utc).isoformat()
    with _connect(db_path) as conn:
        if set_active:
            conn.execute("UPDATE model_evaluations SET is_active = 0")
        conn.execute(
            """
            INSERT INTO model_evaluations (version, mean_error, timestamp, is_active)
            VALUES (?, ?, ?, ?)
            """,
            (version, float(mean_error), ts, 1 if set_active else 0),
        )
        conn.commit()


def get_active_model_version(
    db_path: pathlib.Path = _DEFAULT_DB,
) -> Optional[str]:
    """Return the version string of the currently active model, or None."""
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT version FROM model_evaluations WHERE is_active = 1 ORDER BY timestamp DESC LIMIT 1"
        ).fetchone()
    return row['version'] if row else None
