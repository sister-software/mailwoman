# `usgov-nad` adapter

US DOT National Address Database (NAD) — ~97M structured US address points,
the single largest US address source available. Federal aggregation of state +
local 911-grade address points, covering essentially every addressable
location in the US.

## Why NAD

Compared to the other US sources in the corpus:

| Source             | Volume        | Shape                                                                              |
| ------------------ | ------------- | ---------------------------------------------------------------------------------- |
| TIGER ADDRFEAT     | ~20M          | segment-level (street + range + ZIP; no locality or house)                         |
| NPPES              | ~7M           | venue + practice address (provider-centric)                                        |
| HRSA/IMLS/state-\* | ~50K combined | venue + address (small but adversarial)                                            |
| **NAD**            | **~97M**      | **full structured: house + street + locality + region + ZIP+4 (+ optional venue)** |

NAD is the only source that provides ground-truth structured address
components at residential scale. Adding it to the corpus is the biggest
single training-data upgrade available.

## Input

The adapter consumes NDJSON shards produced by `fetch-nad.ts`'s featureserver
mode. Each shard is `oids_<start>-<end>.ndjson` with a sibling `.manifest.json`.

Point `--input` at the directory of shards:

```sh
npx mailwoman corpus run usgov-nad \
  --input /data/corpus/sources/usgov-nad/featureserver/ \
  --output /data/corpus/aligned/
```

The adapter iterates every `.ndjson` in the directory, skipping the
`quarantined-bash-bug/` subdir (legacy of the bash-fetcher's silent-page-
failure bug — see `fetch-nad.ts` PR notes).

## NAD v9 schema fields consumed

| NAD field                                                                                                                  | ComponentTag   |
| -------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `AddNo_Full` (with `AddNum_Pre + Add_Number + AddNum_Suf` fallback)                                                        | `house_number` |
| `StNam_Full` (with `St_PreMod + St_PreDir + St_PreTyp + St_PreSep + St_Name + St_PosTyp + St_PosDir + St_PosMod` fallback) | `street`       |
| `Post_City` > `Inc_Muni` > `Census_Plc` > `Uninc_Comm` (first non-empty)                                                   | `locality`     |
| `State` (2-char USPS, including territories: PR, GU, VI, AS, MP)                                                           | `region`       |
| `Zip_Code` + `Plus_4` (joined as `XXXXX-NNNN` when both present)                                                           | `postcode`     |
| `LandmkName` (typically a park, school, hospital, named facility)                                                          | `venue`        |

All other NAD fields (geometry, county, FIPS, addressing authority, anomaly
status, etc.) are ignored — Phase 1 is component-level only; spatial fields
belong in a future Phase 5+ adapter.

## Output

One `CanonicalRow` per NAD record where the address quad is populated:

- `raw`: `"<venue>, <house_number> <street>, <locality>, <region> <postcode>"`
- `components`: `{ venue?, house_number?, street?, locality, region, postcode }`
- `country`: `"US"`
- `locale`: `"en-US"`
- `license`: `"Public Domain"`
- `source_id`: `"usgov-nad-<UUID>"` (NAD's stable UUID) or
  `"usgov-nad-<OBJECTID>"` when UUID is absent

## Filtering

Rows are dropped (silently) when:

- `State` is not a recognized USPS abbreviation or territory code
- All locality alternates are empty (`Post_City`, `Inc_Muni`, `Census_Plc`,
  `Uninc_Comm`)
- `Zip_Code` is empty (postcode is required — NAD records always have one
  when they have a State + Post_City)
- After `reconcileComponents`, no component value survives in `raw` (pre-
  flight alignment check; mirrors the other adapters)

Rows with no street parts but a `LandmkName` (e.g. "Yellowstone National Park")
still emit a valid `venue + locality + region + postcode` row — useful for
training the venue tagger on named places without street addresses.

## Country filter

`--country US` is allowed (no-op since NAD is US-only). Any other country
value is rejected with a clear error.

## License

Every emitted row carries `license: "Public Domain"` per 17 U.S.C. § 105
(works of the US federal government). Source-licensing strategy doc at
`docs/licensing-strategy.md` confirms NAD as Tier A (PD-equivalent, safe for
proprietary-weights training without attribution beyond the model card).

## Fixture

`fixtures/fixture.ndjson` — 12 hand-crafted NAD records covering:

- Standard urban address (Pine Hill Park, NY)
- Venue + address (White House, DC)
- ZIP+4 form (Springfield OR with Plus_4)
- Venue-only / no street (Yellowstone NP)
- Hyphenated NYC house number (40-12 Bell Blvd)
- St_PreDir + St_PosTyp composition (Saint Petersburg FL)
- PR territory (San Juan)
- AddNo_Full + StNam_Full both null → fallback composition (Burlington VT)
- Minimal record (Honolulu, just house + street + city + state + zip)
- Empty Post_City (dropped)
- Unrecognized state ZZ (dropped)
- Empty Zip_Code (dropped)

All UUIDs are illustrative; only the first row's UUID is from real data.

## Why a fresh adapter rather than the v0.1.x cluster of state-\* small adapters

Putting NAD into the corpus single-handedly closes most of the v0.1.x
coverage gaps (residential US addresses, Hawaiian + Alaskan + territory
coverage that TIGER under-represented, ZIP+4 examples). The state-\* adapter
work (#35-#41) is still useful for the per-state regional-style variety and
the venue+address pairing those provide; NAD doesn't subsume them.
