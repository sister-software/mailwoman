---
sidebar_position: 30
title: Containment and tree projection
tags:
  - concepts
  - decoder
  - architecture
  - schema
---

# Containment and tree projection

After the encoder produces emissions, the FST priors add their biases, and
Viterbi finds the best valid BIO sequence
([see those sub-articles](./how-the-model-reasons.md)), the last step turns
that flat label sequence into a hierarchical `AddressTree`. This is the
piece that lets downstream consumers ask "what's the locality?" or "how
does this street nest inside its admin parent?" without doing the structural
walk themselves.

The piece is small but load-bearing. It's where the schema's parent/child
rules turn an array of labeled tokens into a queryable tree.

## What the tree looks like

For `123 Main St, Boston, MA 02101`:

```mermaid
flowchart TB
    R1[root: country US] -.no country in input.-> SKIP[ ]
    R[region 'MA'] --> L[locality 'Boston']
    L --> S[street 'Main St']
    S --> HN[house_number '123']
    L --> PC[postcode '02101']

    style SKIP display:none
    style R1 display:none
```

Five `AddressNode`s with these relationships:

- `region` parents nothing (root in this address)
- `locality` parents to `region`
- `street` parents to `locality`
- `house_number` parents to `street`
- `postcode` parents to `locality` (siblings of street)

The decoder didn't "discover" this structure from the address text. It
walked a rule table that says "given these tags, here's how they nest."

## The rule table: PARENT_OF

`core/decoder/containment.ts` exports `PARENT_OF: Partial<Record<ComponentTag, ComponentTag[]>>`. Each tag lists its
preferred parents in priority order. Excerpt:

```ts
export const PARENT_OF: Partial<Record<ComponentTag, ComponentTag[]>> = {
	// Universal coarse — geographic granularity
	region: ["country"],
	subregion: ["region", "country"],
	locality: ["subregion", "region", "country"],
	dependent_locality: ["locality"],
	postcode: ["locality", "subregion", "region", "country"],
	cedex: ["postcode", "locality"],

	// Street-level
	street: ["dependent_locality", "locality", "subregion", "region"],
	street_prefix: ["street"],
	street_suffix: ["street"],
	house_number: ["street"],
	unit: ["street", "house_number"],

	// Venue / mailing
	venue: ["street", "locality"],
	po_box: ["locality", "subregion", "region"],

	// JP-specific
	prefecture: ["country"],
	block: ["district"],
	sub_block: ["block"],
	building_number: ["sub_block", "block"],
}
```

Reading the rule for `street`: a street tries to nest under
`dependent_locality` first, then `locality`, then `subregion`, then
`region`. The tree builder walks this list and parents the street to the
first listed tag that ACTUALLY has a labeled span in this address.
Missing tags fall through.

## The tree-building walk

`core/decoder/build-tree.ts` does the projection in three passes:

1. **Span aggregation.** Walk the BIO sequence, group consecutive
   same-tag tokens into spans. `[B-street, I-street, I-street]` becomes
   one street span covering all three tokens.
2. **Parent resolution.** For each span, walk its `PARENT_OF` list. Find
   the first parent-tag that has a labeled span in this address. If
   multiple spans of the parent tag exist (multiple localities, say),
   pick the one nearest by character distance.
3. **Tree assembly.** Spans whose parent tag has no labeled span become
   tree roots. All others attach as children of their resolved parent.

The output is `AddressTree { raw, roots: AddressNode[] }`. Each
`AddressNode` carries `tag`, `start`, `end`, `value`, `confidence`,
`children`.

## What the projection buys you

### It's deterministic, given the labels

The encoder + FST priors + Viterbi produce the labels. Everything after
that is rule-table application. Two different runs that produce the same
BIO sequence will produce bit-identical trees. This makes the decoder
behavior easy to reason about and easy to test.

### It surfaces structural correctness as a separate axis

A model can produce per-token labels that are correct in isolation but
structurally weird:

- A locality span with no parent region (just floats at the root)
- Two locality spans in one address (Brooklyn AND New York)
- A house_number without a street parent (the resolver downstream
  doesn't know how to handle this)

These are "labels correct, structure wrong" failures. They show up in
the tree, not in per-tag recall. A tree validator (planned, not yet
shipped — see
[corpus-poisoning-vulnerability.md](./corpus-poisoning-vulnerability.md)'s
deferred items) would check the AddressTree's structural validity as a
final quality gate.

### It's the schema's source of truth

The `PARENT_OF` map is the canonical statement of "what nests in what."
The
[street-supplement architecture](./street-supplement-architecture.md)
treats this as the schema's source of truth — extending it (e.g. adding
`dependent_street → street`) is a schema-level decision that flows into
training corpus design, eval golden sets, and downstream consumers.

The
[WOF hierarchy gap](./wof-hierarchy-gap.md) doc explores how WOF's
placetype DAG and mailwoman's `PARENT_OF` map are related but distinct
ontologies — the model's tags answer "what role does this span play in
an address," while WOF's placetypes answer "what kind of geographical
feature is this." The containment rules let us project model output
into either ontology cleanly.

## What this CAN'T do

- **Multi-parent.** Each span has exactly one parent. The DAG-like
  fact that a `borough` can nest under both `locality` and `localadmin`
  in WOF doesn't carry over — the decoder picks one.
- **Cross-address linkage.** The tree is per-address. If you parse a
  list of addresses and want to detect that they all share the same
  locality, that's a resolver concern, not a decoder one.
- **Disagreement resolution.** If the BIO sequence has two locality
  spans that disagree (say one is "Brooklyn" and one is "New York" in
  the same input), the tree builder produces both as separate spans
  parenting to whatever they parent to. The downstream resolver
  decides what to do with that.

## See also

- [How the model reasons](./how-the-model-reasons.md) — the central
  pipeline; this article expands stage 6
- [Viterbi and BIO validity](./viterbi-and-bio-validity.md) — what
  produces the BIO sequence this article consumes
- [WOF hierarchy gap](./wof-hierarchy-gap.md) — the relationship between
  mailwoman's PARENT_OF and WOF's placetype DAG
- [Street-supplement architecture](./street-supplement-architecture.md) —
  the layered design that extends `PARENT_OF` for street-side components
- `core/decoder/containment.ts` — the actual rule table
- `core/decoder/build-tree.ts` — the projection algorithm
