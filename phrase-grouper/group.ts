/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `groupPhrases` — Stage 2.7 entry point.
 *
 *   FIRST COMMIT: stubbed implementation returning an empty proposal list. The public types contract
 *   is the load-bearing piece — downstream consumers (Thread C-s classifier mocks, Thread D-s
 *   reconcile mocks) can pin against the imported types now; the real rule-based grouper lands in
 *   the next commit on this branch.
 *
 *   When implemented, this composes per-kind scorers (proximity, punctuation, capitalization,
 *   hyphenation, format-shape repetition) over the normalized input + QueryShape and emits one
 *   proposal per fired rule. See `docs/articles/concepts/the-knowledge-ladder.md` § Phrase
 *   grouper.
 */

import type { GroupPhrasesOpts, LocaleHint, NormalizedInputLite, PhraseProposal, QueryShapeLike } from "./types.js"

/**
 * Synchronous, pure rule-based implementation. The async wrapper matches the pipeline contract.
 *
 * Currently returns an empty list — the rule scorers land in a follow-up commit. Callers can wire
 * this into the pipeline today without breaking the result shape.
 */
export function groupPhrasesSync(
	_input: NormalizedInputLite,
	_shape: QueryShapeLike,
	_locale?: LocaleHint,
	_opts: GroupPhrasesOpts = {}
): PhraseProposal[] {
	return []
}

/**
 * Async variant matching `RuntimePipelineStages.groupPhrases`. Wraps the sync impl so the pipeline
 * coordinator can use it as-is.
 */
export async function groupPhrases(
	input: NormalizedInputLite,
	shape: QueryShapeLike,
	locale?: LocaleHint,
	opts?: GroupPhrasesOpts
): Promise<PhraseProposal[]> {
	return groupPhrasesSync(input, shape, locale, opts)
}
