"""Turning one corpus-version entry into the commands and checks a sync runs.

Pure: no Modal, no network, no filesystem. That is what makes it testable — `launch/sync.py` is the
thin Modal function that runs what this returns, and the parity test calls this directly.

The table holds the PARTS of a command and this assembles them. Storing assembled strings instead
would make the parity test an identity check: it would compare a stored string to itself and pass
however wrong the command was.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: The R2 bucket every source reads from, and the volume mount every destination writes to. Both
#: appear once here rather than in each of the 137 command strings.
BUCKET = "mailwoman-assets"
VOLUME_MOUNT = "/data"

# rclone flag sets, named for what they trade. R2 intermittently answers 501, so every set that
# moves a corpus carries `--low-level-retries 30 --retries 8`; each operation succeeds on a retry.
#: Large corpora: the most parallelism, with progress logged because the transfer outlives a glance.
WIDE = "--low-level-retries 30 --retries 8 --transfers 12 --checkers 24 --stats 30s --stats-log-level NOTICE"
#: Moderate parallelism, no progress logging.
STEADY = "--low-level-retries 30 --retries 8 --transfers 8 --checkers 16"
#: STEADY with progress logging.
STEADY_LOGGED = STEADY + " --stats 30s --stats-log-level NOTICE"
#: The widest, for the one sync that moves the whole base corpus.
WIDEST = "--transfers 16 --checkers 32 --stats 30s --stats-log-level NOTICE"
#: No retry budget. Used only where the source is small and a failure is cheap to repeat.
NARROW = "--transfers 4"
PLAIN = "--transfers 8"

#: Which `__pycache__` directories a sync clears. A container-side write of new `.py` over old
#: leaves stale `.pyc` that imports instead, so a sync that ships code must clear them.
NONE: tuple[str, ...] = ()
PACKAGE = ("__pycache__",)
PACKAGE_AND_CONFIGS = ("__pycache__", "configs/__pycache__")

#: Where the training package lands on the volume. The pycache paths above are relative to it.
PACKAGE_ROOT = "corpus-python/src/mailwoman_train"


@dataclass(frozen=True)
class Copy:
    """One rclone transfer: a path under the bucket, a path under the volume, and the flag set.

    Source and destination are both carried because they disagree for 100 of the 194 transfers —
    a corpus lands under `corpus/versioned/`, a single lexicon file lands in a directory. Deriving
    one from the other would be inventing a rule the launcher does not follow.
    """

    source: str
    destination: str
    flags: str = WIDE


@dataclass(frozen=True)
class CorpusVersion:
    """What one sync stages, and what it verifies afterwards."""

    copies: tuple[Copy, ...] = ()
    pycache: tuple[str, ...] = PACKAGE
    checks: tuple[str, ...] = field(default=())


@dataclass(frozen=True)
class SyncPlan:
    """The commands to run and the paths to verify, fully resolved."""

    rclone_commands: list[str]
    check_paths: list[str]
    pycache_paths: list[str]


def plan_sync(entry: CorpusVersion) -> SyncPlan:
    """Assemble one version's commands and absolute paths."""
    return SyncPlan(
        rclone_commands=[
            f"rclone copy :s3:{BUCKET}/{copy.source} {VOLUME_MOUNT}/{copy.destination} {copy.flags}"
            for copy in entry.copies
        ],
        check_paths=[f"{VOLUME_MOUNT}/{path}" for path in entry.checks],
        pycache_paths=[f"{VOLUME_MOUNT}/{PACKAGE_ROOT}/{path}" for path in entry.pycache],
    )
