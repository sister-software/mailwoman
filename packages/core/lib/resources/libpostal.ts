// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The language vocabulary libpostal's dictionaries are keyed by.
 *
 *   The loaders that read those dictionaries into memory (`prepareLocaleIndex`, `getAvailableLanguages`,
 *   `generatePlurals`) were v1's lexicon path and are gone. The dictionaries themselves are still live, as build input:
 *   the corpus street-decompose adapters read them, and `gazetteer-pipeline/{fst,street-morphology,evidence-lexicons}`
 *   compile them into the artifacts the parser loads at runtime.
 */

import type { Alpha2LanguageCode } from "#resources/languages"

/**
 * A libpostal dictionary language, or `all` for the language-agnostic directory.
 */
export type LibPostalLanguageCode = Alpha2LanguageCode | "all"
