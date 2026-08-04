# PIX1 — mailwoman placetype-pair index, schema 3 (2026-08-04).
#
# Normative binary-layout spec for `pair-index-<cc>.bin`, the retrieval artifact that maps a folded
# (child, parent) place-name pair to the TYPED EDGE the pair resolves to — e.g. ("shoreditch",
# "london") → dependent_locality under locality. Written for the outside contributor (or a coding agent with a
# limited context window) who needs to read or emit the format without the mailwoman tree in their
# head. The reference implementation owns BOTH ends of the format in one file:
# `neural/pair-index-resolver.ts` (`serializePairIndex` / `PairIndexResolver`). The layout below is
# kept honest by the "PIX1 layout conformance" test in `neural/pair-index-resolver.test.ts`, which
# walks serializer output against this document's field order rather than against the reader.
#
# Semantics Kaitai cannot express, stated here as prose:
#
# 1. header_json is UTF-8 JSON (`PairIndexHeader`). Required fields:
#      country        — lowercase ISO 3166-1 alpha-2 the index was built for; readers hard-gate on it.
#      delta          — calibrated soft-prior bias magnitude (log-score units), consumer-interpreted.
#      schemaVersion  — MUST be exactly 3. Readers refuse both older (rebuild the artifact) and newer.
#      foldVersion    — which text fold child/parent were built under (1 = normalizeFSTToken: NFKC,
#                       lowercase, punctuation/symbol strip). Probe strings must use the same fold.
#      tagTable       — array of tag-name strings; tag_idx AND parent_tag_idx below both index THIS
#                       table, never any external enum. This makes the binary self-describing and
#                       immune to reordering of the consumer's tag union. A reader must reject a record
#                       whose table entry it does not recognize, and must tolerate unrecognized entries
#                       no record uses.
#      sourceMD5s     — provenance: md5s of the source file(s) the pairs were extracted from.
#      buildDate      — ISO timestamp of the build.
#    Optional fields (absence-tolerant — no version bump when they appear). For each, ABSENT means the
#    mechanism is OFF, which is not the same statement as a magnitude of zero:
#      transitionBeta — per-country transition-bonus magnitude; absent = no transition term.
#      parentDelta    — per-country whole-edge parent-bias magnitude; absent = the consumer biases only
#                       the child span, never the parent's.
#    Extension builders may carry additional keys (e.g. the hierarchy probe's `edge`, `source`,
#    `probeArtifact`); readers ignore keys they do not consult.
#
# 2. Records are sorted ascending by the (child, parent) tuple, compared as UTF-16 code units —
#    child first, parent as tiebreak. Sorting makes builds byte-deterministic, so the artifact md5
#    recorded in a model card identifies the build.
#
# 3. Duplicate (child, parent) pairs are forbidden. Serializers must refuse them rather than
#    last-write-win — a duplicate is a shard-build bug, not a merge decision.
#
# 4. child and parent are stored ALREADY FOLDED (see foldVersion). A probe with unfolded text will
#    miss; the fold is not part of this format, it is a contract with the consumer.
#
# 5. A record asserts BOTH ends of the edge. tag_idx names what the CHILD span resolves to and
#    parent_tag_idx what the PARENT span does. The two are independent: a producer must read the
#    parent's tag from its own source's semantics rather than deriving it from the child's tag, because
#    the child does not determine it — the same dependent_locality child legitimately sits under a
#    locality parent in one source and under another dependent_locality (a borough) in the next.
#
# 6. Retired schema versions. Readers refuse BOTH, with guidance to rebuild via
#    `mailwoman gazetteer pair-index`; there is no tolerant fallback for either.
#      1 (retired 2026-08-04) — no tagTable; tag_idx indexed the consumer's tag union positionally.
#      2 (retired 2026-08-04) — tagTable present, but records stopped after tag_idx and the consumer
#        derived the parent's tag from a containment table. Reading v2 bytes as v3 would consume the
#        NEXT record's child_len as a parent tag, so the refusal is a correctness requirement, not a
#        policy choice.

meta:
  id: pix1
  title: mailwoman PIX1 placetype-pair index (schema 3)
  file-extension: bin
  endian: le
  encoding: UTF-8

seq:
  - id: magic
    contents: "PIX1"
  - id: header_len
    type: u4
  - id: header_json
    size: header_len
    type: str
    doc: UTF-8 JSON PairIndexHeader — see the prose block above for field semantics.
  - id: pair_count
    type: u4
  - id: pairs
    type: pair
    repeat: expr
    repeat-expr: pair_count

types:
  pair:
    seq:
      - id: child_len
        type: u2
      - id: child
        size: child_len
        type: str
        doc: Folded child place name (e.g. a dependent-locality candidate).
      - id: parent_len
        type: u2
      - id: parent
        size: parent_len
        type: str
        doc: Folded parent place name the child was observed under.
      - id: tag_idx
        type: u1
        doc: Index into the header's tagTable — the CHILD span's tag. Out-of-range is a hard error.
      - id: parent_tag_idx
        type: u1
        doc: |
          Index into the same tagTable — the PARENT span's tag (schema 3). Out-of-range is a hard
          error. Recorded, never derived: see prose note 5.
