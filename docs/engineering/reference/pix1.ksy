# PIX1 — mailwoman placetype-pair index, schema 2 (2026-08-04).
#
# Normative binary-layout spec for `pair-index-<cc>.bin`, the retrieval artifact that maps a folded
# (child, parent) place-name pair to the component tag the pair resolves to — e.g. ("shoreditch",
# "london") → dependent_locality. Written for the outside contributor (or a coding agent with a
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
#      schemaVersion  — MUST be exactly 2. Readers refuse both older (rebuild the artifact) and newer.
#      foldVersion    — which text fold child/parent were built under (1 = normalizeFSTToken: NFKC,
#                       lowercase, punctuation/symbol strip). Probe strings must use the same fold.
#      tagTable       — array of tag-name strings; tag_idx below indexes THIS table, never any
#                       external enum. This makes the binary self-describing and immune to reordering
#                       of the consumer's tag union. A reader must reject a record whose table entry
#                       it does not recognize, and must tolerate unrecognized entries no record uses.
#      sourceMD5s     — provenance: md5s of the source file(s) the pairs were extracted from.
#      buildDate      — ISO timestamp of the build.
#    Optional fields (absence-tolerant — no version bump when they appear):
#      transitionBeta — per-country transition-bonus magnitude; absent = no transition term.
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
# 5. schemaVersion 1 (retired 2026-08-04): no tagTable; tag_idx indexed the consumer's tag union
#    positionally. Readers refuse v1 with guidance to rebuild via `mailwoman gazetteer pair-index`.

meta:
  id: pix1
  title: mailwoman PIX1 placetype-pair index (schema 2)
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
        doc: Index into the header's tagTable. Out-of-range is a hard error.
