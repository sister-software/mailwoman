/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The language vocabulary libpostal's dictionaries are keyed by.
 *
 *   The dictionaries are build input rather than a runtime lexicon: the corpus street-decompose adapters read
 *   them, and `gazetteer-pipeline/{fst,street-morphology,evidence-lexicons}` compile them into the artifacts the
 *   parser loads at runtime.
 */

import type { Alpha2LanguageCode } from "#resources/languages"

/**
 * A libpostal dictionary language, or `all` for the language-agnostic directory.
 */
export type LibPostalLanguageCode = Alpha2LanguageCode | "all"
