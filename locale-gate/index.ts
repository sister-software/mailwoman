/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `@mailwoman/locale-gate` — Stage 2 of the runtime pipeline.
 *
 *   Rule-based locale detection from `QueryShape`'s script + known-format hits. Returns a
 *   `LocaleHint` with the top candidate + alternatives, surfacing detector disagreement when the
 *   caller's `--locale` hint differs from what the input shape implies.
 *
 *   Bitter-lesson-safe: only universal structural cues (script, postcode patterns), no place-name
 *   dictionaries. Trained character-level model is a v0.6.0 follow-on.
 *
 *   See `docs/articles/plan/reference/STAGES.md` § Stage 2 for the contract.
 */

export { detectLocale, detectLocaleSync } from "./detect.ts"
export { scoreByPostcode, scoreByScript, scoreFallback } from "./rules.ts"
export type { LocaleCandidate } from "./rules.ts"
export type { DetectLocaleOpts, LocaleHint, LocaleTag, NormalizedInputLite, QueryShapeLike } from "./types.ts"
