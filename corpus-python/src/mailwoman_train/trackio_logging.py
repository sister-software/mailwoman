"""Optional Trackio experiment-tracking shim for the Phase 2 training loop.

Trackio (https://huggingface.co/docs/trackio) is a lightweight, ``wandb``-compatible
experiment tracker. We mirror the metrics already written to ``train_log.csv`` into a
Trackio project so training curves and cross-version eval metrics show up on a
self-hosted Hugging Face Space dashboard (free CPU-basic tier) instead of only living
in a CSV. With ``space_id`` set, Trackio deploys/syncs the dashboard Space and persists
every run to a backing HF Dataset; with no ``space_id`` it logs to a local dashboard
(``~/.cache/huggingface/trackio``).

Design rule — tracking must NEVER crash training. An A100 run costs real money and the
night-shift workflow runs unattended; a metrics upload that 401s, a missing package, or
an API drift must degrade to CSV-only, not take the run down with it. So:

  * the whole thing no-ops when ``cfg.train.trackio_enabled`` is False (the default), or
    when the ``trackio`` package isn't installed (plain tokenizer-only installs don't
    pull it in — see corpus-python/pyproject.toml ``[train]`` extra);
  * ``init`` failures fall back to a null tracker (CSV-only);
  * every ``log``/``finish`` call swallows exceptions behind a one-line warning.

Auth: Trackio uploads to the Space using the HF cached login or ``HF_TOKEN``. On Modal,
``HF_TOKEN`` is injected via the ``hf_secret`` in scripts/modal/train_remote.py; locally
it uses your ``hf auth login`` token. No token -> Space upload fails -> CSV-only.
"""

from __future__ import annotations

from typing import Any


class _NullTracker:
    """No-op tracker. Returned when tracking is disabled or unavailable."""

    enabled = False

    def log(self, metrics: dict[str, Any], step: int | None = None) -> None:  # noqa: D102
        pass

    def finish(self) -> None:  # noqa: D102
        pass


class _TrackioTracker:
    """Thin best-effort wrapper around the ``trackio`` module. Never raises."""

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
    """Initialize Trackio for this run, or return a no-op tracker.

    Reads ``cfg.train.trackio_enabled`` / ``trackio_project`` / ``trackio_space`` /
    ``trackio_run_name``. Returns a tracker whose ``.log()`` / ``.finish()`` are safe to
    call unconditionally from the training loop.
    """
    tcfg = cfg.train
    if not getattr(tcfg, "trackio_enabled", False):
        return _NullTracker()

    try:
        import trackio
    except ImportError:
        print("  [trackio] trackio_enabled=True but the 'trackio' package isn't installed "
              "— logging to CSV only. (pip install trackio)")
        return _NullTracker()

    init_kwargs: dict[str, Any] = {"project": getattr(tcfg, "trackio_project", "mailwoman")}
    space_id = getattr(tcfg, "trackio_space", "")
    if space_id:
        init_kwargs["space_id"] = space_id
        # Honor the private flag only on Space-backed runs (ignored if the Space exists).
        init_kwargs["private"] = bool(getattr(tcfg, "trackio_private", True))
    # Stable run name (explicit, else derived from output_dir) + resume="allow" so a
    # restart-on-hang continues the same run rather than forking a new dashboard line.
    init_kwargs["name"] = getattr(tcfg, "trackio_run_name", "") or _default_run_name(
        getattr(tcfg, "output_dir", "")
    )
    init_kwargs["resume"] = "allow"
    init_kwargs["config"] = _run_config(cfg)

    try:
        trackio.init(**init_kwargs)
    except Exception as exc:
        print(f"  [trackio] init failed (ignored, logging to CSV only): {exc}")
        return _NullTracker()

    print(f"  [trackio] tracking run -> project={init_kwargs['project']} "
          f"space={space_id or '(local dashboard)'}")
    return _TrackioTracker(trackio)


def _default_run_name(output_dir: str) -> str:
    """Derive a stable run name from the output dir so resumes continue the same run.

    ``/data/output-v072/checkpoints`` -> ``output-v072`` (the bare ``checkpoints`` leaf
    isn't distinctive, so fall back to its parent).
    """
    import os

    base = os.path.basename(output_dir.rstrip("/"))
    if base in ("", "checkpoints"):
        base = os.path.basename(os.path.dirname(output_dir.rstrip("/")))
    return base or "run"


def _run_config(cfg: Any) -> dict[str, Any]:
    """A flat, comparison-relevant snapshot of the run's hyperparameters.

    Kept to flat scalars (rather than ``asdict`` of the whole nested Config) so it renders
    cleanly as filterable columns in the Trackio dashboard — these are the knobs we
    actually sweep between model versions.
    """
    t, m, d = cfg.train, cfg.model, cfg.data
    return {
        # Human-readable legend shown in the run's config panel — so a viewer who isn't
        # steeped in the metrics knows how to read the charts (esp. the blank/gap ones).
        "_legend": (
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
