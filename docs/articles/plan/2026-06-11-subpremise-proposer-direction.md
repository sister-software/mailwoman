# The sub-premise nexus — pre-tagging as information, not decision (direction note)

Operator instinct, 2026-06-11: "if there's any utility in pre-tagging PO Box as a pre-model
stage, so be it… there's some nexus of secondary address pieces — apartments, suites, units,
levels." Written down here with the bigger shape it connects to.

## The nexus is real and has one grammar

PO Box 123 · Apt 4B · Suite 500 · Unit 9 · Level 12 · 3rd Floor · Private Bag 39990 · Drawer
61547 · CMB B99 — every one is **DESIGNATOR + IDENTIFIER**: a closed-vocabulary leader (now
provenance-tracked across `codex/us|fr|ca|au|nz`) followed by a short id with per-designator
shape rules. Addressing standards treat them as one family too (USPS "secondary unit
designators"; AU's subpremise forms in the same AMAS table the #517 slices mined; NZ Post's
delivery-service types). The model currently learns each tag's instances separately
(`unit` shard, `po_box/cedex` shard) and shares nothing across the family.

## Why pre-tagging-as-OVERRIDE stays rejected

The deterministic pre-tagger was measured and reversed once already (#464: the country
override — perfect on a no-homograph eval, wrong on ethos and on contested surfaces). "Drawer"
is a filing cabinet in a venue name; "Level" is a street name in places; "Box" is a surname.
A pre-model stage that DECIDES steals exactly the contested cases the model exists for.

## The three slots pre-tagging-as-INFORMATION already has

The architecture has rightful homes for this instinct, in escalating order of ambition:

1. **Input-layer clue (knowledge ladder rung 3.2 — cheapest, partially built).** The gazetteer
   channel's 5 dims already include a `po_box` bit. The nexus version: a **subpremise clue
   dimension** that fires on ANY codex designator (unit, level, po_box-class, all locales) —
   one bit + the designator's tag-class, the same multi-hot pattern. The model conditions; it
   never obeys. Cost: a lexicon rebuild + a channel-dim bump (retrain-coupled — rides a
   scheduled run, not its own).
2. **Stage 2.7 phrase proposal (the operator's instinct, structurally).** The phrase grouper
   already carries a "unit gate"; the generalization is a **sub-premise proposer**: one rule
   layer over all codex designator tables emitting typed span proposals
   (`{span: "PO Box 123", kind: PO_BOX_PHRASE, confidence}`), consumed as phrase priors today —
   the classifier conditions on the boundary hypothesis and can still disagree. This also
   subsumes the #518 bracket/paren proposer's machinery (same stage, same output contract) —
   one proposer, two cue families (designators + paired delimiters).
3. **Stage 5 second emitter (#478's capstone — where this is ultimately heading).** Codex
   matchers emit full CANDIDATES (`po_box="P.O. Box 19"` at chars 0–11, conf from matcher
   precision) into reconcile's beam alongside the classifier's top-K; arbitration picks per
   evidence. This is "the rules system lives on as a candidate source" — the model-first
   answer to v0's remaining edge-format wins (the postal arena's label formats are exactly
   where v0 still beats neural).

## Sequencing against the live board

Slot 2 is the natural first build: it needs no retrain (priors are inference-side), its
machinery is shared with the #518 revival verdict, and the v0.5.0 char-offset format makes its
proposals directly storable as supervision later. Slot 1 rides whichever retrain comes after
v0.5.0. Slot 3 is #478's existing capstone — this note adds the sub-premise family as its
first candidate-emitter vocabulary, with the proposer (slot 2) as its dress rehearsal.

Levels/floors join the family when their codex sourcing pass lands (noted on #517 — the AMAS
documentation already mined covers AU Level/Unit forms).
