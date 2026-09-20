// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `@mailwoman/variant-aliases` — regional variant alias table for amenity/brand queries.
 *
 *   The data file (`data/aliases.json`) catalogs ~35 hand-curated regional terms: "servo" → fuel
 *   (en-AU), "マクド" → McDonald's (ja-JP), "PFK" → KFC (fr-CA), etc.
 *
 *   The runtime uses this table when resolving POI intent.
 */

export { VARIANT_ALIAS_VERSION, getAllAliases, lookupVariantAliases, resolveLocaleScope } from "#lookup"

export type {
	AliasLookupResult,
	AmenityAlias,
	BrandAlias,
	LocaleScope,
	LocaleScopeMatch,
	VariantAlias,
	VariantAliasTable,
	VariantKind,
} from "#types"
