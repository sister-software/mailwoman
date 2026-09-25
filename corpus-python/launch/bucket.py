from __future__ import annotations

import subprocess

from .app import app, r2_secret, training_image
from .corpora import CORPUS_VERSIONS
from .plan import BUCKET, CORPUS_SOURCE_ROOT, corpus_versions


def _prefixes(path: str) -> list[str]:
    result = subprocess.run(  # noqa: S603
        ["rclone", "lsd", f":s3:{BUCKET}/{path}"],  # noqa: S607
        capture_output=True,
        text=True,
        check=True,
    )
    names: list[str] = []
    for line in result.stdout.splitlines():
        parts = line.split(maxsplit=4)
        if len(parts) == 5:
            names.append(parts[4])
    return names


@app.function(image=training_image, secrets=[r2_secret], timeout=300)
def bucket_census() -> dict[str, list[str]]:
    staged: set[str] = set()
    for entry in CORPUS_VERSIONS.values():
        staged.update(corpus_versions(entry))

    on_bucket = _prefixes(f"{CORPUS_SOURCE_ROOT}/")
    present = sorted(version for version in staged if version in set(on_bucket))
    missing = sorted(version for version in staged if version not in set(on_bucket))
    unstaged = sorted(prefix for prefix in on_bucket if prefix not in staged)

    print(f"bucket {CORPUS_SOURCE_ROOT}/ holds {len(on_bucket)} prefixes")
    print(f"the table stages {len(staged)} versions across {len(CORPUS_VERSIONS)} rows\n")
    print(f"STAGED AND PRESENT ({len(present)})")
    for version in present:
        print(f"  {version}")
    print(f"\nSTAGED AND MISSING ({len(missing)}) — each of these syncs nothing and exits 0")
    for version in missing:
        print(f"  {version}")
    print(f"\nON THE BUCKET, NO ROW ({len(unstaged)})")
    for prefix in unstaged:
        print(f"  {prefix}")

    if missing:
        raise RuntimeError(f"{len(missing)} staged version(s) are not on the bucket: {missing}")
    return {"present": present, "missing": missing, "unstaged": unstaged}
