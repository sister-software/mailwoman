#!/usr/bin/env python3
"""
@copyright Sister Software
@license AGPL-3.0
@author Teffen Ellis, et al.

Publish the public demo assets to the Cloudflare R2 bucket the demo serves from
(nexus-public → https://public.sister.software/mailwoman/...). This codifies the
hosting migration so a model release isn't a one-off manual rclone.

The demo reads EVERYTHING from R2 at runtime (model, tokenizer, fst, postcode-*.bin,
wof-hot.db, wof-polygons.db, releases.json) plus the same-origin sql.js-httpvfs
worker that lives in the Pages deploy. This pushes the R2 half.

Two R2 gotchas this handles (learned the hard way — see memory
project-sqlite-over-http-spike):
  - rclone's `copy` 501s on a post-PUT op against R2 (needs --s3-no-head
    --s3-disable-checksum --no-update-modtime) AND its --header-upload silently
    drops Cache-Control. boto3 `upload_file` with ExtraArgs sets Content-Type +
    Cache-Control on the multipart create itself — one clean step, no 501.
  - sql.js-httpvfs range-reads the DBs cross-origin, so the objects MUST carry a
    sane Content-Type (octet-stream, NOT gzipped by Cloudflare) and a long
    immutable Cache-Control so Cloudflare edge-caches the byte ranges.

Credentials come from the RCLONE_S3_PUBLIC_* env vars (repo .env): source them
first, e.g.  `set -a; . ./.env; set +a; python3 scripts/publish-demo-assets-to-r2.py ...`

Usage:
  publish-demo-assets-to-r2.py --src <staged-dir> [--bucket nexus-public] [--prefix mailwoman] [--dry-run]

  <staged-dir> mirrors the R2 layout under the prefix, e.g.
    <src>/en-us/v4.0.0/{model.onnx,tokenizer.model,model-card.json,fst-en-US.bin,postcode-*.bin,wof-hot.db,wof-polygons.db}
    <src>/en-us/releases.json
  (The sql.js-httpvfs worker is staged into the Pages deploy by the demo-assets
   plugin, NOT here — it must be same-origin.)
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

CACHE_CONTROL = "public, max-age=604800, immutable"
# Content-Type by extension. The DBs/model/binaries MUST be octet-stream so Cloudflare
# doesn't gzip them (gzipped ranges break sql.js-httpvfs).
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
    v = os.environ.get(name)
    if not v:
        sys.exit(f"missing env var {name} (source the repo .env first)")
    return v


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="staged asset dir mirroring the R2 layout under the prefix")
    ap.add_argument("--bucket", default="nexus-public")
    ap.add_argument("--prefix", default="mailwoman")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = Path(args.src)
    if not src.is_dir():
        sys.exit(f"--src is not a directory: {src}")

    s3 = boto3.client(
        "s3",
        endpoint_url=env("RCLONE_S3_PUBLIC_ENDPOINT"),
        aws_access_key_id=env("RCLONE_S3_PUBLIC_ACCESS_KEY_ID"),
        aws_secret_access_key=env("RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY"),
        region_name=os.environ.get("RCLONE_S3_PUBLIC_REGION", "auto"),
        config=Config(signature_version="s3v4"),
    )

    files = sorted(p for p in src.rglob("*") if p.is_file())
    if not files:
        sys.exit(f"no files under {src}")

    total = 0
    for p in files:
        rel = p.relative_to(src).as_posix()
        key = f"{args.prefix}/{rel}"
        ct = CONTENT_TYPE.get(p.suffix.lower(), "application/octet-stream")
        size_mb = p.stat().st_size / 1024 / 1024
        total += p.stat().st_size
        if args.dry_run:
            print(f"  [dry-run] {key}  ({ct}, {size_mb:.1f} MB)")
            continue
        s3.upload_file(
            str(p),
            args.bucket,
            key,
            ExtraArgs={"ContentType": ct, "CacheControl": CACHE_CONTROL},
        )
        print(f"  ✓ {key}  ({ct}, {size_mb:.1f} MB)")

    print(f"\n{'(dry-run) ' if args.dry_run else ''}{len(files)} objects, {total / 1024 / 1024:.1f} MB → {args.bucket}/{args.prefix}/")
    print("Served at https://public.sister.software/{}/...".format(args.prefix))


if __name__ == "__main__":
    main()
