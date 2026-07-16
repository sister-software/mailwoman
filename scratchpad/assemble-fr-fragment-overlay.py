"""Assemble the v0.10.9-fr-fragment overlay = v5's 700 base refs (persist on the volume) + the NEW
synth-fr-fragment shard (#727 T2).

Unlike assemble-v7-overlay.py, this APPENDS a source rather than swapping the existing fragment part:
synth-fr-fragment is a new source with its own weight, and synth-fragment stays exactly as it is. The
base refs stay /data-rooted and untouched — the ONE variable is the new shard.

Flow (the campaign overlay flow, AGENTS.md):
  1. /tmp/fr-fragment.jsonl  ->  parquet part
  2. v5 manifest + one appended shard entry, /data-rooted
  3. verify 0 /mnt paths (the v1.6.0 reroot trap)
  4. push to the Modal volume

Run from repo root:  python3 scratchpad/assemble-fr-fragment-overlay.py
"""

import hashlib
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

DR = Path("/mnt/playpen/mailwoman-data")
VER = "v0.10.9-fr-fragment"
SRC_JSONL = Path("/tmp/fr-fragment.jsonl")
OVERLAY = DR / f"corpus/versioned/{VER}/corpus-{VER}"
PART_REL = "train/part-fr-fragment.parquet"
PART_DATA_PATH = f"/data/corpus/versioned/{VER}/corpus-{VER}/{PART_REL}"

BASE_MANIFEST = Path("scratchpad/v5-manifest.json")


def main() -> None:
    m = json.load(open(BASE_MANIFEST))
    base_shards = m["shards"]
    assert not any(s.get("source") == "synth-fr-fragment" for s in base_shards), "already applied"

    # ---- 1. jsonl -> parquet, schema-matched to the existing parts ----------------------------
    rows = [json.loads(line) for line in open(SRC_JSONL, encoding="utf-8") if line.strip()]
    assert rows, f"{SRC_JSONL} is empty — build the shard first"

    # Match the corpus schema exactly. A column the loader doesn't know is dead weight; a missing one
    # is a silent drop.
    ref = pq.ParquetFile(
        DR / "corpus/staging/fragment-v8/part-fragment.parquet"
    )
    ref_schema = ref.schema_arrow
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

    # ---- 2. append the shard entry ------------------------------------------------------------
    entry = {
        "split": "train",
        "path": PART_DATA_PATH,
        "format": "parquet",
        "compression": "SNAPPY",
        "rows": n,
        "bytes": size,
        "sha256": sha,
        "source": "synth-fr-fragment",
        "first_source_id": rows[0].get("source_id"),
        "last_source_id": rows[-1].get("source_id"),
    }
    m["shards"] = base_shards + [entry]
    m["corpus_version"] = VER.lstrip("v")
    m["overlay_base"] = "v0.10.6-fragment-v5"
    m["note"] = (
        "v0.10.6-fragment-v5 base VERBATIM + the NEW synth-fr-fragment shard (#727 T2 — the "
        "house-number-licence lever; BAN Licence Ouverte). Streets with NO house number and NO "
        "locality, plus the bare-locality counter-distribution. Eval surfaces excluded via the "
        "fragment board's reserved list (source-disjoint by street surface). Night 2026-07-16."
    )
    if "total_rows" in m:
        m["total_rows"] = sum(s.get("rows", 0) for s in m["shards"])

    # ---- 3. the reroot trap (v1.6.0) ----------------------------------------------------------
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
