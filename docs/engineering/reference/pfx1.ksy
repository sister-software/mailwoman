# PFX1 — mailwoman postcode-prefix index, schema 1 (2026-08-14).
#
# Normative binary-layout spec for `postcode-prefix-<scope>.bin`, the retrieval artifact that maps a
# postcode PREFIX — a partial code that still encodes ancestry — to the admin surfaces it asserts and,
# when the source can honestly support one, a centroid with its own measured dispersion. GB's outward
# code (`SW1A`), a US sectional centre (`941`), an NI district (`BT9`). Written for the outside
# contributor (or a coding agent with a limited context window) who needs to read or emit the format
# without the mailwoman tree in their head. The reference implementation owns BOTH ends of the format
# in one file: `neural/postcode-prefix-index.ts` (`serializePostcodePrefixIndex` /
# `PostcodePrefixIndexResolver`).
#
# PFX1 is the fourth member of the PCB1/PIX1/PCN1 family and follows PIX1 exactly through the header:
# magic, `u32 header_len`, UTF-8 JSON. It diverges after that, because a prefix record is
# variable-shape where a PIX1 pair is fixed.
#
# Semantics Kaitai cannot express, stated here as prose:
#
# 1. header_json is UTF-8 JSON (`PostcodePrefixHeader`). Required fields:
#      country        — ISO 3166-1 alpha-2 the index was built for; readers hard-gate on it.
#      scope          — sub-national scope slug, and the filename suffix. Two files may share a
#                       `country`; this is what tells them apart. `gb-esw` is Code-Point Open (England,
#                       Scotland, Wales — NO Northern Ireland), `gb-ni` is the BT districts. The split
#                       is a LICENCE boundary, not a format one: folding an ODbL register into an OGL
#                       artifact would put a share-alike obligation on it that nothing downstream
#                       could see.
#      schemaVersion  — MUST be exactly 1. Readers refuse both older and newer.
#      levels         — which prefix granularity the node table carries: `["outward"]` for GB,
#                       `["3"]` for a US sectional-centre build.
#      source         — the NUMBERING AUTHORITY the prefixes came from, NOT the gazetteer they were
#                       joined to. M-3 is the receipt: 7.9% of US ZIPs disagree with their own
#                       gazetteer parent's state, because a firm/unique ZIP names an organization's
#                       mail processor rather than the code's range. An index derived from
#                       `spr.parent_id` bakes that misattribution in.
#      sourceMD5s     — md5s of the source artifact(s), the same discipline as PCN1's.
#      buildDate      — ISO date of the build.
#      tier           — `shipped` | `build-local`, in the sense `layer-contract.mdx` uses.
#      attribution    — licence attribution carried through from the source, so a copied artifact
#                       still names the terms it travels under.
#      coverageNote   — MANDATORY meaning-of-zero statement: what a MISS means for THIS file. A prefix
#                       absent from a complete register does not exist; a prefix absent from a partial
#                       one may simply be unattested, and a consumer that cannot tell the two apart
#                       will read coverage as fact.
#    Optional (absence-tolerant — no version bump when it appears). ABSENT means the mechanism is OFF,
#    which is not the same statement as a magnitude of zero:
#      delta          — soft-prior bias magnitude. Absent until a calibration measures one; a defaulted
#                       number here would let an uncalibrated bias reach the decoder unnoticed (PCN1's
#                       rule, verbatim).
#
# 2. Nodes are sorted ascending by `prefix`, compared as UTF-16 code units. Sorting makes builds
#    byte-deterministic, so the artifact md5 identifies the build.
#
# 3. Duplicate prefixes are forbidden. Serializers refuse them rather than last-write-win — a
#    duplicate means two extractions were merged without SUMMING `unit_count`.
#
# 4. `prefix` is stored in the sanitized-query token shape (#920): every non-letter/number stripped,
#    uppercased for the letter-bearing systems. A probe with unsanitized text will miss; the
#    sanitization is not part of this format, it is a contract with the consumer.
#
# 5. The ancestor DICTIONARY is the anti-repetition device. A country's prefixes assert a handful of
#    distinct admin surfaces between them — GB's 2,863 outward codes reference FIVE entries — so
#    per-node inlining would be almost all repetition. Dictionary order is FIRST-SEEN over the SORTED
#    node list, which is what makes the file deterministic. Identity is the (placetype, wofID, name)
#    triple, not wofID alone.
#
# 6. `wof_id` is an f64, not a u4. WOF IDs are not bounded by 2^32 — the NI extract's synthetic postcode
#    IDs start at 9.8e12. f64 is exact to 2^53 and the serializer asserts each ID against
#    `Number.MAX_SAFE_INTEGER`, so an ID beyond the safe range fails the build rather than
#    round-tripping to a neighbour. A reader in a language with native integers should read the 8
#    bytes as a double and convert, checking exactness.
#
# 7. `ancestors` may legitimately be EMPTY, and that is a real answer rather than a build failure: a
#    GB outward code in one of the two documented border-straddling postcode areas asserts the United
#    Kingdom and nothing finer. Ancestry is COARSEST-FIRST.
#
# 8. The coordinate is OPTIONAL and its ABSENCE IS MEANINGFUL — the ancestry-only tier. It is carried
#    in a flags bit, never as a `0,0` sentinel, because a magnitude never carries its own absence.
#    Northern Ireland is the standing case: 80 BT districts whose only permissively-licensed
#    coordinate source attests 9.5% of the units, where a centroid would describe the SAMPLE and not
#    the district.
#
# 9. `radius_p95_km` is MANDATORY whenever a coordinate is present and FORBIDDEN without one. The
#    serializer throws in both directions. A US 1-digit band and a GB outward code are both "a prefix
#    with a centroid" and they differ by 200× (695.8 km median p95 vs 3.24 km); an artifact that
#    shipped the coordinate without the radius would invite a consumer to treat them alike. It is a
#    p95 under the house percentile convention (nearest-rank, `p` in [0,100]); the alternative
#    `ceil(p/100 × n) − 1` differs by 0.53% over the GB outward set, which matters to a consumer
#    comparing this field against a number computed elsewhere.
#
# 10. Coordinate quantization is identical to PCB1's: `lat_q = round(lat / 90 × 32767)`,
#     `lon_q = round(lon / 180 × 32767)` — about 300 m. A prefix prior whose own p95 radius is
#     measured in kilometres has nothing to gain from a finer grid. Decode is the inverse:
#     `lat = lat_q × 90 / 32767`.
#
# 11. `unit_count` is units OBSERVED under this prefix at build time — the denominator behind
#     `radius_p95_km`, and, for a partial source, the number that says how partial. It is an
#     observation, never a claim about how many units exist.

meta:
  id: pfx1
  title: mailwoman PFX1 postcode-prefix index (schema 1)
  file-extension: bin
  endian: le
  encoding: UTF-8

seq:
  - id: magic
    contents: "PFX1"
  - id: header_len
    type: u4
  - id: header_json
    size: header_len
    type: str
    doc: UTF-8 JSON PostcodePrefixHeader — see the prose block above for field semantics.
  - id: ancestor_count
    type: u4
  - id: ancestors
    type: ancestor
    repeat: expr
    repeat-expr: ancestor_count
    doc: The interned ancestor dictionary. Nodes reference it by index; see prose note 5.
  - id: node_count
    type: u4
  - id: nodes
    type: node
    repeat: expr
    repeat-expr: node_count

types:
  ancestor:
    doc: One admin surface a prefix asserts, interned once per file.
    seq:
      - id: placetype_len
        type: u1
      - id: placetype
        size: placetype_len
        type: str
        doc: WOF placetype of the surface — "country", "macroregion", "region".
      - id: wof_id
        type: f8
        doc: |
          Who's on First ID — the join key a consumer resolves against the gazetteer. f64, NOT u32:
          see prose note 6.
      - id: name_len
        type: u1
      - id: name
        size: name_len
        type: str
        doc: Display name, carried so a trace line is readable without a gazetteer round-trip.

  node:
    doc: One prefix and everything it asserts.
    seq:
      - id: prefix_len
        type: u1
        doc: Never 0 — the serializer refuses an empty prefix.
      - id: prefix
        size: prefix_len
        type: str
        doc: Sanitized-query token shape; see prose note 4.
      - id: ancestor_ref_count
        type: u1
      - id: ancestor_refs
        type: u4
        repeat: expr
        repeat-expr: ancestor_ref_count
        doc: |
          Indices into the file's ancestor dictionary, COARSEST-FIRST. Out-of-range is a hard error.
          May be empty; see prose note 7.
      - id: flags
        type: u1
        doc: bit0 = coordinate present, bit1 = radius_p95_km present. Bits 2-7 reserved, must be 0.
      - id: lat_q
        type: s2
        if: has_coordinate
        doc: Quantized latitude; see prose note 10. Present ONLY when bit0 is set.
      - id: lon_q
        type: s2
        if: has_coordinate
      - id: radius_p95_km
        type: f4
        if: has_radius
        doc: |
          Measured p95 great-circle km from this prefix's centroid to its observed units — the prior's
          own confidence, shipped rather than assumed. Present ONLY when bit1 is set, and bit1 may not
          be set without bit0; see prose note 9.
      - id: unit_count
        type: u4
        doc: Units OBSERVED at build time; see prose note 11.
    instances:
      has_coordinate:
        value: (flags & 1) != 0
      has_radius:
        value: (flags & 2) != 0
