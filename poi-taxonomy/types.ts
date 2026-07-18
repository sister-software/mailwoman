/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Types for the POI category taxonomy. Categories come from two namespaces: the Overture Places
 *   `taxonomy` snapshot (shipped-tier data; the old `categories` property is dead as of Overture's
 *   Sept 2026 release, so ONLY the new property is modeled), and the `mailwoman-infra` extension
 *   for street-furniture/infrastructure classes that exist only in ODbL sources (fire hydrants,
 *   post boxes) — recognized by the lexicon even when no build-local layer is present.
 */

declare const POICategoryIDBrand: unique symbol

/** A category id, e.g. `hospital`, `gas_station`, `fire_hydrant`. Branded — cast via {@link toPOICategoryID}. */
export type POICategoryID = string & { readonly [POICategoryIDBrand]: true }

/** Brand a raw string as a {@link POICategoryID}. Purely a compile-time assertion. */
export function toPOICategoryID(id: string): POICategoryID {
	return id as POICategoryID
}

/** Which namespace a category belongs to. */
export const CategorySource = {
	/** The Overture Places `taxonomy` snapshot (CDLA-Permissive-2.0). */
	Overture: "overture",
	/** Mailwoman's infrastructure extension — data lives only in build-local (ODbL) layers. */
	MailwomanInfra: "mailwoman-infra",
} as const
export type CategorySource = (typeof CategorySource)[keyof typeof CategorySource]

/** One category node. */
export interface CategoryRecord {
	id: POICategoryID
	/** Human-readable display label, e.g. `Gas station`. */
	label: string
	/** Ordered ancestry, top level first, ENDING with this category's own id. */
	hierarchy: POICategoryID[]
	/** Overture "basic category" display tier, when the snapshot provides one. */
	basicLabel: string | null
	source: CategorySource
}

/** One lexicon entry mapping a query phrase to a category. */
export interface SynonymEntry {
	/** The phrase as typed, lowercase, e.g. `drinking fountain`. */
	phrase: string
	categoryID: POICategoryID
	/**
	 * BCP-47 locale gate, same semantics as `@mailwoman/variant-aliases`: omitted = ungated (matches any locale at
	 * confidence 1.0); present = 1.0 on exact locale, 0.5 on language-only.
	 */
	locales?: string[]
}

/** The on-disk shape of `data/taxonomy.json`. */
export interface POITaxonomyTable {
	version: string
	/** Overture release the category snapshot was taken from; null until Plan 3 lands the full snapshot. */
	overtureRelease: string | null
	categories: CategoryRecord[]
	synonyms: SynonymEntry[]
}
