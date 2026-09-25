#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Uploads the demo's runtime assets to the Cloudflare R2 bucket behind
https://public.mailwoman.ai/mailwoman/.

This script is the only producer of the demo's R2 objects. The sql.js-httpvfs worker must be
same-origin, so the docs demo-assets plugin stages it into the Pages deploy instead.

The upload uses boto3 because rclone's `--header-upload` drops Cache-Control on R2. sql.js-httpvfs
reads the databases with cross-origin range requests, so each object needs an uncompressed
Content-Type and a long immutable Cache-Control.

Credentials come from the RCLONE_S3_PUBLIC_* variables in the repo .env file:

  set -a; . ./.env; set +a
  python3 docs/scripts/publish-demo-assets-to-r2.py --src <staged-dir> [--bucket nexus-public] [--prefix mailwoman] [--dry-run]

The staged directory mirrors the R2 layout under the prefix. Stage it by hand, for example:

  <src>/en-us/v4.0.0/{model.onnx,tokenizer.model,model-card.json,fst-en-US.bin,postcode-*.bin,wof-hot.db,wof-polygons.db}
  <src>/en-us/releases.json
  <src>/pair-index/2026-08-05/pair-index-{gb,nz}.bin
"""

import argparse
import os
import sys
from pathlib import Path

try:
    import boto3
    from botocore.config import Config
except ImportError:
    sys.exit("boto3 is required: pip install boto3")

# Versioned assets never change, so they are cached for a week as immutable.
CACHE_CONTROL = "public, max-age=604800, immutable"
# releases.json changes when the default version changes, so its cache is short.
MUTABLE_CACHE_CONTROL = "public, max-age=60, must-revalidate"
MUTABLE_FILES = {"releases.json"}
# Files in these directories must sit under a generation segment, `<dir>/<generation>/<file>`.
# An overwritten immutable key keeps serving the old bytes from the CDN. When staging a new
# pair-index generation, update PAIR_INDEX_VERSION in the demo to match.
VERSIONED_DIRS = {"pair-index"}
# Databases, models and binaries use octet-stream so that Cloudflare does not gzip them, which
# would break range requests.
CONTENT_TYPE = {
    ".db": "application/octet-stream",
    ".onnx": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".model": "application/octet-stream",
    ".json": "application/json",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
}


def env(name: str) -> str:
    """Return a required environment variable, or exit with a message when it is unset."""
    v = os.environ.get(name)
    if not v:
        sys.exit(f"missing env var {name} (source the repo .env first)")
    return v


def main() -> None:
    """Upload every file under ``--src`` to the bucket with its Content-Type and Cache-Control."""
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--src",
        required=True,
        help="staged asset dir mirroring the R2 layout under the prefix",
    )
    ap.add_argument("--bucket", default="nexus-public")
    ap.add_argument("--prefix", default="mailwoman")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        sys.exit(f"--src is not a directory: {src}")

    files = sorted(p for p in src.rglob("*") if p.is_file())
    if not files:
        sys.exit(f"no files under {src}")

    # The layout check runs before credentials are read, so it also runs under --dry-run.
    unversioned = [
        r
        for r in (p.relative_to(src).as_posix() for p in files)
        if r.split("/")[0] in VERSIONED_DIRS and r.count("/") < 2
    ]
    if unversioned:
        sys.exit(
            "refusing to publish un-versioned objects under an immutable Cache-Control:\n  "
            + "\n  ".join(unversioned)
            + "\n\nThese dirs need a generation segment — `<dir>/<generation>/<file>`, e.g.\n"
            "  pair-index/2026-08-05/pair-index-gb.bin\n"
            "Overwriting a flat key leaves the CDN serving the old bytes for a week.\n"
            "Bump PAIR_INDEX_VERSION in docs/src/shared/resources.tsx to match."
        )

    s3 = boto3.client(
        "s3",
        endpoint_url=env("RCLONE_S3_PUBLIC_ENDPOINT"),
        aws_access_key_id=env("RCLONE_S3_PUBLIC_ACCESS_KEY_ID"),
        aws_secret_access_key=env("RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY"),
        region_name=os.environ.get("RCLONE_S3_PUBLIC_REGION", "auto"),
        config=Config(signature_version="s3v4"),
    )

    total = 0
    for p in files:
        rel = p.relative_to(src).as_posix()
        key = f"{args.prefix}/{rel}"
        ct = CONTENT_TYPE.get(p.suffix.lower(), "application/octet-stream")
        cc = MUTABLE_CACHE_CONTROL if p.name in MUTABLE_FILES else CACHE_CONTROL
        size_mb = p.stat().st_size / 1024 / 1024
        total += p.stat().st_size
        if args.dry_run:
            print(f"  [dry-run] {key}  ({ct}, {cc}, {size_mb:.1f} MB)")
            continue
        s3.upload_file(
            str(p),
            args.bucket,
            key,
            ExtraArgs={"ContentType": ct, "CacheControl": cc},
        )
        print(f"  ✓ {key}  ({ct}, {cc}, {size_mb:.1f} MB)")

    print(
        f"\n{'(dry-run) ' if args.dry_run else ''}{len(files)} objects, {total / 1024 / 1024:.1f} MB → {args.bucket}/{args.prefix}/"
    )
    print(f"Served at https://public.mailwoman.ai/{args.prefix}/...")


if __name__ == "__main__":
    main()
