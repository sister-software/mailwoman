"""Staging the registries corpus from the LOCAL checkout, when the bucket cannot be reached.

The normal path is `launch/syncs.py`: local -> R2 -> a container-side rclone -> the volume. This is
the same container-side write and commit with no bucket in between, for when the R2 token answers
401 — it did on 2026-09-07, locally and from a Modal container alike, and a corpus that is built and
cannot be staged is a run that cannot start.

    MAILWOMAN_DATA_ROOT=<root> modal run -m launch.train_remote::stage_v8cjk_regs

The mount is read at `modal run` time, so the image below is built from whatever the local data root
holds then. A corpus the root does not have is reported as not mounted rather than skipped silently.
"""

from __future__ import annotations

import os

from .app import VOL_MOUNT, app, training_image, vol
from .corpora import CORPUS_VERSIONS
from .plan import corpus_versions
from .syncs import verify_staged

#: The corpora this path stages, READ OFF the row the bucket path would have transferred. Retyping
#: the list here is how the two spellings come to disagree, and the disagreement is silent: a
#: corpus this list forgets is simply never copied, and the run fails later on a missing slice.
V8CJK_REGS_CORPORA = tuple(corpus_versions(CORPUS_VERSIONS["v8cjk_regs"]))

_LOCAL_DATA_ROOT = os.environ.get("MAILWOMAN_DATA_ROOT", "")
_LOCAL_CORPUS_PYTHON = os.path.join(os.path.dirname(__file__), "..")

_stage_image = training_image.add_local_dir(
    os.path.join(_LOCAL_CORPUS_PYTHON, "src"), remote_path="/staged/corpus-python/src"
).add_local_dir(os.path.join(_LOCAL_CORPUS_PYTHON, "scripts"), remote_path="/staged/corpus-python/scripts")

if _LOCAL_DATA_ROOT:
    for _name in V8CJK_REGS_CORPORA:
        _local = os.path.join(_LOCAL_DATA_ROOT, "corpus", "versioned", _name)
        if os.path.isdir(_local):
            _stage_image = _stage_image.add_local_dir(_local, remote_path=f"/staged/corpus/versioned/{_name}")


@app.function(
    image=_stage_image,
    volumes={VOL_MOUNT: vol},
    timeout=3600,
)
def stage_v8cjk_regs() -> None:
    """Copy the mounted local corpora and training code into the volume and commit; verify like the sync would."""
    import shutil

    vol.reload()
    for relative in (
        "corpus-python/src",
        "corpus-python/scripts",
        *(f"corpus/versioned/{name}" for name in V8CJK_REGS_CORPORA),
    ):
        source = f"/staged/{relative}"
        if not os.path.isdir(source):
            print(f"  (not mounted) {relative}")
            continue
        target = f"{VOL_MOUNT}/{relative}"
        shutil.copytree(source, target, dirs_exist_ok=True)
        print(f"  copied {relative}")

    package = f"{VOL_MOUNT}/corpus-python/src/mailwoman_train"
    for pyc in (f"{package}/__pycache__", f"{package}/configs/__pycache__"):
        if os.path.isdir(pyc):
            shutil.rmtree(pyc)

    vol.commit()
    verify_staged("v8cjk_regs")
    print("\nv8-cjk-regs staged from the local mount. Volume committed.")
