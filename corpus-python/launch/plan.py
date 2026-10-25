from __future__ import annotations

from dataclasses import dataclass, field

from .settings import settings

BUCKET = settings().bucket
VOL_MOUNT = settings().volume_mount

#: R2 refuses the bucket-existence check rclone makes before a write with `NotImplemented`, so every write
#: fails until this is passed. `.env` sets `RCLONE_S3_NO_CHECK_BUCKET`, but a flag here does not depend on
#: the container's secret carrying it.
NO_CHECK_BUCKET = "--s3-no-check-bucket"

WIDE = (
    f"{NO_CHECK_BUCKET} --low-level-retries 30 --retries 8 --transfers 12 --checkers 24 "
    "--stats 30s --stats-log-level NOTICE"
)


STEADY = f"{NO_CHECK_BUCKET} --low-level-retries 30 --retries 8 --transfers 8 --checkers 16"


PACKAGE = ("__pycache__",)
PACKAGE_AND_CONFIGS = ("__pycache__", "configs/__pycache__")


PACKAGE_ROOT = "corpus-python/src/mailwoman_train"


CORPUS_SOURCE_ROOT = "corpus"
CORPUS_VOLUME_ROOT = "corpus/versioned"


NESTED = "nested"

WRAPPED = "wrapped"

FLAT = "flat"

LAYOUTS = (NESTED, WRAPPED, FLAT)


def detect_layout(version: str, prefixes: list[str]) -> str:
    """The layout of `corpus/<version>/` on the bucket, read from the directory names directly under it.

    `mailwoman corpus upload` sends a nested local entry's inner `corpus-<version>/` to `corpus/<version>/`,
    which is `WRAPPED`. A hand-run `rclone copy` of the whole entry leaves `corpus-<version>/` under the key,
    which is `NESTED`. Reading the bucket keeps one reader for both writers. `FLAT` cannot be told apart from
    `WRAPPED` on the bucket, so it is reachable only through an explicit `--layout`.
    """
    return NESTED if f"corpus-{version}" in prefixes else WRAPPED


@dataclass(frozen=True)
class Copy:
    source: str
    destination: str
    flags: str = WIDE

    version: str | None = None


def corpus(version: str, layout: str = NESTED, *, flags: str = WIDE) -> Copy:
    inner = f"corpus-{version}/"
    source = f"{CORPUS_SOURCE_ROOT}/{version}/" + (inner if layout == NESTED else "")
    destination = f"{CORPUS_VOLUME_ROOT}/{version}/" + ("" if layout == FLAT else inner)
    return Copy(source, destination, flags, version=version)


def mirror(path: str, *, flags: str = WIDE) -> Copy:
    return Copy(path, path, flags)


def file_into(path: str, *, flags: str = WIDE, directory: str | None = None) -> Copy:
    return Copy(path, directory if directory is not None else path.rsplit("/", 1)[0] + "/", flags)


@dataclass(frozen=True)
class CorpusVersion:
    copies: tuple[Copy, ...] = ()
    pycache: tuple[str, ...] = PACKAGE
    checks: tuple[str, ...] = field(default=())

    verifier: tuple[str, str] | None = None


@dataclass(frozen=True)
class Transfer:
    source: str
    destination: str
    flags: str

    @property
    def command(self) -> str:
        return f"rclone copy {self.source} {self.destination} {self.flags}"


@dataclass(frozen=True)
class SyncPlan:
    transfers: list[Transfer]
    check_paths: list[str]
    pycache_paths: list[str]

    @property
    def rclone_commands(self) -> list[str]:
        return [transfer.command for transfer in self.transfers]


def corpus_versions(entry: CorpusVersion) -> list[str]:
    return [copy.version for copy in entry.copies if copy.version is not None]


def resolve(copy: Copy) -> Transfer:
    return Transfer(f":s3:{BUCKET}/{copy.source}", f"{VOL_MOUNT}/{copy.destination}", copy.flags)


def plan_sync(entry: CorpusVersion) -> SyncPlan:
    return SyncPlan(
        transfers=[resolve(copy) for copy in entry.copies],
        check_paths=[f"{VOL_MOUNT}/{path}" for path in entry.checks],
        pycache_paths=[f"{VOL_MOUNT}/{PACKAGE_ROOT}/{path}" for path in entry.pycache],
    )
