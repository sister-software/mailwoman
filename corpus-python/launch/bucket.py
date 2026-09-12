"""Reading the bucket against the table: what is stored, what is staged, and what neither reaches.

The table says what a sync COPIES. It cannot say what the bucket HOLDS, and the difference is
invisible from either side on its own — a row naming a prefix that is not there stages nothing and
rclone exits 0, and a prefix no row names is storage no launch can reach. Both have happened.

This runs on Modal rather than locally because the R2 credentials already live there as a secret,
and because a test cannot hold them: a check that needs the network and a key is a check that gets
skipped, and a skip reads exactly like a clean result.

    modal run -m launch.train_remote::bucket_census
"""

from __future__ import annotations

import subprocess

from .app import app, r2_secret, training_image
from .corpora import CORPUS_VERSIONS
from .plan import BUCKET, CORPUS_SOURCE_ROOT, corpus_versions


def _prefixes(path: str) -> list[str]:
    """The directory names directly under one bucket path."""
    result = subprocess.run(  # noqa: S603
        ["rclone", "lsd", f":s3:{BUCKET}/{path}"],  # noqa: S607
        capture_output=True,
        text=True,
        check=True,
    )
    names: list[str] = []
    for line in result.stdout.splitlines():
        # `lsd` prints size, count, date, time, then the name; only the name is wanted.
        parts = line.split(maxsplit=4)
        if len(parts) == 5:
            names.append(parts[4])
    return names


@app.function(image=training_image, secrets=[r2_secret], timeout=300)
def bucket_census() -> dict[str, list[str]]:
    """Compare every corpus prefix on the bucket against every version the table stages.

    Three answers, and the second is the one that costs a run:

    - STAGED: a version some row names, present on the bucket. Working as intended.
    - MISSING: a version a row names that the bucket does not hold. The sync copies nothing and
      rclone exits 0, so the launch proceeds against an empty directory.
    - UNSTAGED: a prefix on the bucket no row names. Sometimes deliberate (a corpus a shipped
      model was trained from, kept for provenance, whose recipe is historical); sometimes a
      MIS-KEYED upload that the convention would have reached — `corpus/0.9.3-slavic-diacritic/`
      holds `corpus-v0.9.3-slavic-diacritic/`, so the outer segment lost the `v` every sibling
      carries and no `corpus()` source path can name it.

    The report names each one rather than counting them: a count cannot be acted on.
    """
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
