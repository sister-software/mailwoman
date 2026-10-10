"""Fit the confidence mapping and check it for drift.

`isotonic` fits a monotone map from a model's raw confidence to its observed accuracy;
`drift_guard` re-measures a shipped map's expected calibration error against fresh results. A
calibrated confidence is what lets a consumer act on a score, so the fit and its check belong
together and apart from the model that produced the scores.
"""

from __future__ import annotations
