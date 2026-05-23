/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/phrase-grouper` — Stage 2.7 of the runtime pipeline.
 *
 *   Proposes coherent input units (boundary discovery) with a structural kind hypothesis +
 *   confidence. Decouples boundary discovery from type classification: Stage 3 conditions on these
 *   proposals so it answers the simpler "what type is this proposed span?" rather than jointly
 *   discovering boundaries and types. Stage 5 consumes the proposals as boundary candidates for
 *   joint decoding.
 *
 *   Bitter-lesson-safe: only universal structural cues (proximity, punctuation, capitalization,
 *   hyphenation, format-shape repetition) — never place-name dictionaries. v0.5.0 ships the
 *   rule-based v1; learned 1-2M-param span proposer reserved for v0.5.1.
 *
 *   See `docs/articles/concepts/the-knowledge-ladder.md` § Phrase grouper for the design rationale
 *   and `docs/articles/plan/phases/PHASE_8_v0_5_0_fresh_slate.md` § E for the v0.5.0 thread.
 */

export { groupPhrases, groupPhrasesSync } from "./group.js"
export {
	scoreHyphenatedCompound,
	scoreLocalityPhrase,
	scoreNumeric,
	scorePostcode,
	scoreRegionAbbreviation,
	scoreStreetPhrase,
	scoreVenuePhrase,
	tokenizeSegment,
} from "./rules.js"
export type { SegmentToken } from "./rules.js"
export type {
	GroupPhrasesOpts,
	LocaleHint,
	NormalizedInputLite,
	PhraseGrouper,
	PhraseKind,
	PhraseProposal,
	QueryShapeLike,
	Section,
} from "./types.js"
