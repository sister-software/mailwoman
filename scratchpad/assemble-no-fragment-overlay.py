"""Assemble the v0.11.0-no-fragment overlay = v0.10.9-fr-fragment (701 refs) + the NEW synth-no-fragment
shard (Track B — the NO house-number-licence lever).

Mirrors assemble-fr-fragment-overlay.py exactly: APPEND a source, base refs /data-rooted and
untouched, the ONE new variable is the shard. Keeps the fr-fragment shard so the probe cannot regress
French while adding Norwegian.

CONTAMINATION NOTE (read before launching a run off this): the base manifest's `synth-no-street-led`
part was built BEFORE no-street-led got --exclude-surfaces (commit 80d86130), so its parquet contains
the 1,952 surfaces the NO digit board reserves. Do NOT let that source flow when grading against the
board — the probe config drops it (synth-no-street-led weight 0.0). Rebuilding it excluded is a
follow-up before any full run that wants it.

Flow (the campaign overlay flow, AGENTS.md):
  1. /tmp/no-fragment.jsonl  ->  parquet part (schema-matched)
  2. v0.10.9 manifest + one appended shard entry, /data-rooted
  3. verify 0 /mnt paths (the v1.6.0 reroot trap)
  4. push to the Modal volume

Run from repo root:  python3 scratchpad/assemble-no-fragment-overlay.py
"""

import hashlib
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

DR = Path("/mnt/playpen/mailwoman-data")
VER = "v0.11.0-no-fragment"
SRC_JSONL = Path("/tmp/no-fragment.jsonl")
OVERLAY = DR / f"corpus/versioned/{VER}/corpus-{VER}"
PART_REL = "train/part-no-fragment.parquet"
PART_DATA_PATH = f"/data/corpus/versioned/{VER}/corpus-{VER}/{PART_REL}"

BASE_MANIFEST = DR / "corpus/versioned/v0.10.9-fr-fragment/corpus-v0.10.9-fr-fragment/MANIFEST.json"
REF_PART = DR / "corpus/staging/fragment-v8/part-fragment.parquet"


def main() -> None:
    m = json.load(open(BASE_MANIFEST))
    base_shards = m["shards"]
    assert not any(s.get("source") == "synth-no-fragment" for s in base_shards), "already applied"

    rows = [json.loads(line) for line in open(SRC_JSONL, encoding="utf-8") if line.strip()]
    assert rows, f"{SRC_JSONL} is empty — build the shard first"

    ref_schema = pq.ParquetFile(REF_PART).schema_arrow
    print("reference schema:", [f.name for f in ref_schema])

    cols: dict[str, list] = {f.name: [] for f in ref_schema}
    for r in rows:
        for name in cols:
            cols[name].append(r.get(name))

    table = pa.Table.from_pydict(cols, schema=ref_schema)
    OVERLAY.joinpath("train").mkdir(parents=True, exist_ok=True)
    out = OVERLAY / PART_REL
    pq.write_table(table, out, compression="SNAPPY", row_group_size=m.get("row_group_size", 50000))

    n = pq.ParquetFile(out).metadata.num_rows
    size = out.stat().st_size
    sha = hashlib.sha256(out.read_bytes()).hexdigest()

    entry = {
        "split": "train",
        "path": PART_DATA_PATH,
        "format": "parquet",
        "compression": "SNAPPY",
        "rows": n,
        "bytes": size,
        "sha256": sha,
        "source": "synth-no-fragment",
        "first_source_id": rows[0].get("source_id"),
        "last_source_id": rows[-1].get("source_id"),
    }
    m["shards"] = base_shards + [entry]
    m["corpus_version"] = VER.lstrip("v")
    m["overlay_base"] = "v0.10.9-fr-fragment"
    m["note"] = (
        "v0.10.9-fr-fragment base VERBATIM + the NEW synth-no-fragment shard (Track B — the NO "
        "house-number-licence lever). Streets with NO postcode/locality partner + bare-locality & "
        "bare-postcode counters. Eval surfaces excluded via the NO digit board's reserved list "
        "(source-disjoint by street surface). NOTE: the base's synth-no-street-led part predates its "
        "own --exclude-surfaces and is contaminated vs the board; drop it (weight 0) when grading. "
        "Night 2026-07-16."
    )
    if "total_rows" in m:
        m["total_rows"] = sum(s.get("rows", 0) for s in m["shards"])

    mnt = sum("/mnt" in s["path"] for s in m["shards"])
    assert mnt == 0, f"{mnt} shard paths still /mnt-rooted — the reroot trap (v1.6.0)"

    (OVERLAY / "MANIFEST.json").write_text(json.dumps(m, indent=1) + "\n")

    print(f"\noverlay assembled: {OVERLAY}")
    print(f"  new shard: {n:,} rows, {size / 1e6:.1f} MB, sha {sha[:12]}")
    print(f"  shards: {len(m['shards'])} ({len(base_shards)} base refs + 1 new); /mnt paths: {mnt}")
    print(f"  total_rows: {m.get('total_rows'):,}")
    print(f"\npush:  modal volume put mailwoman-training {OVERLAY} corpus/versioned/{VER}/corpus-{VER} --force")


if __name__ == "__main__":
    main()
