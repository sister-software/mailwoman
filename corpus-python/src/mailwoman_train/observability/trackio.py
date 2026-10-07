"""Optional Trackio shim for Phase 2 training.

What this does
- Mirrors metrics from ``train_log.csv`` into Trackio.
- Gives a dashboard for curves + cross-version eval metrics.
- Works with:
    - Hugging Face Space (when ``space_id`` is set), backed by an HF Dataset.
    - Local dashboard (when ``space_id`` is empty):
        ``~/.cache/huggingface/trackio``.

Non-negotiable rule
- The tracker must never crash training.

Failure behavior (by design)
- ``cfg.train.trackio_enabled=False`` (default) -> no-op tracker.
- ``trackio`` package missing -> no-op tracker (CSV-only).
- ``trackio.init(...)`` fails -> no-op tracker (CSV-only).
- ``log`` / ``finish`` failures -> warning only, then continue training.

Auth notes
- Space uploads use cached HF login or ``HF_TOKEN``.
- On Modal, ``HF_TOKEN`` comes from ``hf_secret`` in
    ``launch/train_remote.py``.
- Locally, it uses ``hf auth login`` credentials.
- No token -> Space upload fails -> CSV-only.
"""

from __future__ import annotations

from typing import Any


class _NullTracker:
    """No-op tracker used when Trackio is disabled or unavailable."""

    enabled = False

    def log(self, metrics: dict[str, Any], step: int | None = None) -> None:  # noqa: D102
        pass

    def finish(self) -> None:  # noqa: D102
        pass


class _TrackioTracker:
    """Best-effort wrapper around ``trackio``. Never raises upstream."""

    enabled = True

    def __init__(self, trackio_mod: Any) -> None:
        self._trackio = trackio_mod

    def log(self, metrics: dict[str, Any], step: int | None = None) -> None:
        try:
            if step is None:
                self._trackio.log(metrics)
            else:
                # ``step`` is part of the wandb-compatible surface, but guard against an
                # API that doesn't accept it by folding step into the payload instead.
                try:
                    self._trackio.log(metrics, step=step)
                except TypeError:
                    self._trackio.log({**metrics, "step": step})
        except Exception as exc:  # logging must never kill training
            print(f"  [trackio] log failed (ignored): {exc}")

    def finish(self) -> None:
        try:
            self._trackio.finish()
        except Exception as exc:
            print(f"  [trackio] finish failed (ignored): {exc}")


def init_tracker(cfg: Any) -> _NullTracker | _TrackioTracker:
    """Initialize Trackio, or return a no-op tracker.

    Reads these config keys from ``cfg.train``:
    - ``trackio_enabled``
    - ``trackio_project``
    - ``trackio_space``
    - ``trackio_run_name``

    Always returns a tracker with safe ``.log()`` and ``.finish()`` calls.
    """
    tcfg = cfg.train
    if not getattr(tcfg, "trackio_enabled", False):
        return _NullTracker()

    try:
        import trackio
    except ImportError:
        print(
            "  [trackio] trackio_enabled=True but the 'trackio' package isn't installed "
            "— logging to CSV only. (pip install trackio)"
        )
        return _NullTracker()

    init_kwargs: dict[str, Any] = {"project": getattr(tcfg, "trackio_project", "mailwoman")}
    space_id = getattr(tcfg, "trackio_space", "")
    if space_id:
        init_kwargs["space_id"] = space_id
        # Honor the private flag only on Space-backed runs (ignored if the Space exists).
        init_kwargs["private"] = bool(getattr(tcfg, "trackio_private", True))
    # Stable run name (explicit, else derived from output_dir) + resume="allow" so a
    # restart-on-hang continues the same run rather than forking a new dashboard line.
    init_kwargs["name"] = getattr(tcfg, "trackio_run_name", "") or _default_run_name(getattr(tcfg, "output_dir", ""))
    init_kwargs["resume"] = "allow"
    init_kwargs["config"] = _run_config(cfg)

    try:
        trackio.init(**init_kwargs)
    except Exception as exc:
        print(f"  [trackio] init failed (ignored, logging to CSV only): {exc}")
        return _NullTracker()

    print(f"  [trackio] tracking run -> project={init_kwargs['project']} space={space_id or '(local dashboard)'}")
    return _TrackioTracker(trackio)


def _default_run_name(output_dir: str) -> str:
    """Build a stable run name from ``output_dir``.

    Example:
    - ``/data/output-v072/checkpoints`` -> ``output-v072``

    If the final path part is ``checkpoints`` (or empty), use the parent folder.
    """
    import os

    base = os.path.basename(output_dir.rstrip("/"))
    if base in ("", "checkpoints"):
        base = os.path.basename(os.path.dirname(output_dir.rstrip("/")))
    return base or "run"


def _run_config(cfg: Any) -> dict[str, Any]:
    """Return flat, comparison-friendly run hyperparameters.

    Why flat scalars only:
    - Cleaner Trackio table columns.
    - Easier filtering/sorting across runs.
    - Focused on knobs actually changed between model versions.
    """
    t, m, d = cfg.train, cfg.model, cfg.data
    return {
        # Human-readable metric legend shown in Trackio config.
        # Important: never prefix this key with "_".
        # Trackio reserves "_..." keys and can reject init() (e.g. "_legend").
        # Rejection gets caught and downgrades to CSV-only.
        "legend": (
            "f1.<tag> = token-level F1 for that address component on the val set (higher is better). "
            "support.<tag> = how many val examples contain that component. A MISSING/BLANK f1.<tag> "
            "chart means support.<tag> = 0 — the val sample has no examples of that tag, so F1 is "
            "undefined; it is NOT a model failure (these are coverage gaps, tracked separately). "
            "val_macro_f1 = average F1 across only the components that have support (excludes 'O' and "
            "absent tags). val_tags_with_support = how many of the 16 components the val set covers. "
            "train_loss/val_loss lower is better; lr = learning rate; wall_seconds = elapsed time."
        ),
        "max_steps": t.max_steps,
        "batch_size": t.batch_size,
        "learning_rate": t.learning_rate,
        "lr_schedule": getattr(t, "lr_schedule", "cosine"),
        "warmup_steps": t.warmup_steps,
        "precision": t.precision,
        "grad_clip_norm": getattr(t, "grad_clip_norm", 0.0),
        "label_smoothing": m.label_smoothing,
        "use_crf": m.use_crf,
        "crf_loss_weight": m.crf_loss_weight,
        "crf_normalization": getattr(m, "crf_normalization", "per_sequence"),
        "hidden_size": m.hidden_size,
        "num_hidden_layers": m.num_hidden_layers,
        "corpus_dir": d.corpus_dir,
        "tokenizer_dir": d.tokenizer_dir,
    }
