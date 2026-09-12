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
#: Moderate parallelism, no progress logging. Used where the transfer is a tokenizer or a
#: checkpoint rather than a corpus — megabytes, not tens of gigabytes.
STEADY = "--low-level-retries 30 --retries 8 --transfers 8 --checkers 16"

#: Which `__pycache__` directories a sync clears. A container-side write of new `.py` over old
#: leaves stale `.pyc` that imports instead, so a sync that ships code must clear them.
PACKAGE = ("__pycache__",)
PACKAGE_AND_CONFIGS = ("__pycache__", "configs/__pycache__")

#: Where the training package lands on the volume. The pycache paths above are relative to it.
PACKAGE_ROOT = "corpus-python/src/mailwoman_train"


#: Where a corpus version lives on each side. A version's name appears in up to four places in a
#: transfer pair, so it is written once and these compose the rest.
CORPUS_SOURCE_ROOT = "corpus"
CORPUS_VOLUME_ROOT = "corpus/versioned"

# How a corpus version's directories nest, which differs by when the version was built rather than
# by anything about its contents. All three shapes are in use; `corpus(...)` names one per row so
# the version string is written once instead of two or four times.
#: Both sides carry the inner `corpus-<version>` directory.
NESTED = "nested"
#: The bucket holds the parts directly; the volume gains the inner `corpus-<version>` directory.
WRAPPED = "wrapped"
#: Neither side carries it.
FLAT = "flat"


@dataclass(frozen=True)
class Copy:
    """One rclone transfer: a path under the bucket, a path under the volume, and the flag set.

    Build these with `corpus`, `mirror` or `file_into` rather than by hand — a literal pair spells
    a version name up to four times, which is how a corpus version comes to exist only as a string
    inside a transfer nobody can enumerate.
    """

    source: str
    destination: str
    flags: str = WIDE

    #: The corpus version this moves, when it moves one. Carried so the set of versions the
    #: launcher knows about can be READ OFF the table — otherwise a version exists only as a
    #: substring of two paths and nobody can answer "which versions are there".
    version: str | None = None


def corpus(version: str, layout: str = NESTED, *, flags: str = WIDE) -> Copy:
    """A corpus version, from the bucket to its place under `corpus/versioned/`.

    `flags` is keyword-only because it and `layout` are both strings: `corpus("v0.10.0", STEADY)`
    reads as a flag choice and binds as a layout, producing a source path that does not exist.
    """
    inner = f"corpus-{version}/"
    source = f"{CORPUS_SOURCE_ROOT}/{version}/" + (inner if layout == NESTED else "")
    destination = f"{CORPUS_VOLUME_ROOT}/{version}/" + ("" if layout == FLAT else inner)
    return Copy(source, destination, flags, version=version)


def mirror(path: str, *, flags: str = WIDE) -> Copy:
    """A directory that lands at the same path on the volume — the training code, the lexicons."""
    return Copy(path, path, flags)


def file_into(path: str, *, flags: str = WIDE, directory: str | None = None) -> Copy:
    """One file, into the directory it already sits in, or into `directory` when it moves."""
    return Copy(path, directory if directory is not None else path.rsplit("/", 1)[0] + "/", flags)


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


def corpus_versions(entry: CorpusVersion) -> list[str]:
    """The corpus versions this entry stages, in order."""
    return [copy.version for copy in entry.copies if copy.version is not None]


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
