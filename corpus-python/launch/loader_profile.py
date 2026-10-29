"""`loader_profile`: the training loader's host-side cost per batch, measured in a CPU container.

The function runs `mailwoman_train.audits.loader_profile` on a config under `/data`. The package comes from this
checkout's `corpus-python/src`, mounted into the image, rather than from the volume's copy, so a measurement of a
loader change neither waits for nor overwrites the code other runs import from the volume.

Usage, from `corpus-python/`:

    uv run --extra dev modal run -m launch.train_remote::loader_profile --config-name v8.3.0-base-c6-90k-mixed-s42.yaml
"""

from __future__ import annotations

from .app import VOL_MOUNT, app, training_image, vol
from .settings import repository_root

#: Where the image mounts this checkout's `corpus-python/src`.
_SOURCE = "/opt/mailwoman-src"

_profile_image = training_image.add_local_dir(str(repository_root() / "corpus-python" / "src"), remote_path=_SOURCE)


@app.function(image=_profile_image, volumes={VOL_MOUNT: vol}, cpu=8.0, memory=32768, timeout=3600)
def loader_profile(config_name: str, batches: int = 40) -> None:
    """Print the stage timings and memory of `config_name`'s train loader, a config the package ships."""
    import sys

    sys.path.insert(0, _SOURCE)
    from mailwoman_train.audits.loader_profile import main
    from mailwoman_train.paths import package_path

    main(["--config", str(package_path("configs", config_name)), "--batches", str(batches)])
