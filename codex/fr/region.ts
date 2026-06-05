/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The 18 French régions (13 metropolitan + 5 overseas), keyed by their ISO 3166-2:FR code.
 *
 *   The contrast with `de/bundesland.ts` and `us/state.ts`: France's regions were redrawn in the 2016
 *   reform that merged 22 metropolitan régions into 13 (Aquitaine + Limousin + Poitou-Charentes →
 *   Nouvelle-Aquitaine, etc.). So a French region is a large, recent amalgamation, and — like a
 *   German Bundesland — it is almost never written on an address line, which reads `code-postal
 *   commune`. The region is inferred from the département, which is inferred from the postcode (see
 *   `code-postal.ts`).
 */

/** Per-region record: ISO 3166-2:FR code (sans `FR-` prefix) + French name. */
export interface FrenchRegionInfo {
	/** ISO 3166-2:FR region code without the `FR-` prefix (e.g. `IDF` for `FR-IDF`). */
	code: string
	/** French name (e.g. `Île-de-France`). */
	name: string
}

/** ISO 3166-2:FR region code → info, for all 18 régions (13 metropolitan + 5 overseas). */
export const FR_REGIONS = {
	ARA: { code: "ARA", name: "Auvergne-Rhône-Alpes" },
	BFC: { code: "BFC", name: "Bourgogne-Franche-Comté" },
	BRE: { code: "BRE", name: "Bretagne" },
	CVL: { code: "CVL", name: "Centre-Val de Loire" },
	COR: { code: "COR", name: "Corse" },
	GES: { code: "GES", name: "Grand Est" },
	HDF: { code: "HDF", name: "Hauts-de-France" },
	IDF: { code: "IDF", name: "Île-de-France" },
	NOR: { code: "NOR", name: "Normandie" },
	NAQ: { code: "NAQ", name: "Nouvelle-Aquitaine" },
	OCC: { code: "OCC", name: "Occitanie" },
	PDL: { code: "PDL", name: "Pays de la Loire" },
	PAC: { code: "PAC", name: "Provence-Alpes-Côte d'Azur" },
	GUA: { code: "GUA", name: "Guadeloupe" },
	MTQ: { code: "MTQ", name: "Martinique" },
	GUF: { code: "GUF", name: "Guyane" },
	LRE: { code: "LRE", name: "La Réunion" },
	MAY: { code: "MAY", name: "Mayotte" },
} as const satisfies Record<string, FrenchRegionInfo>

/** An ISO 3166-2:FR region code (`ARA`, `IDF`, `PAC`, …). */
export type FrenchRegionCode = keyof typeof FR_REGIONS

const REGION_CODE_SET: ReadonlySet<string> = new Set(Object.keys(FR_REGIONS))

/** Type-predicate for an ISO 3166-2:FR region code. Case-insensitive. */
export function isFrenchRegionCode(input: unknown): input is FrenchRegionCode {
	return typeof input === "string" && REGION_CODE_SET.has(input.toUpperCase())
}

/** Strip diacritics + lowercase so `Île-de-France`, `ile-de-france`, `Ile de France` all key alike. */
function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

/**
 * Folded region name / code → ISO 3166-2:FR code. Built diacritic-insensitive so the resolver's
 * surface form (`Île-de-France`, or an unaccented `Ile-de-France`) maps regardless of accents.
 * Mirrors `de/bundesland.ts`'s `lookupGermanState`, the same role: fold a region surface form to
 * one code so a resolver eval can compare like-for-like without a US-USPS-shaped matcher.
 */
export const FR_REGION_NAME_TO_CODE: ReadonlyMap<string, FrenchRegionCode> = (() => {
	const out = new Map<string, FrenchRegionCode>()
	for (const code of Object.keys(FR_REGIONS) as FrenchRegionCode[]) {
		out.set(foldName(FR_REGIONS[code].name), code)
		out.set(code.toLowerCase(), code)
	}
	return out
})()

/**
 * Resolve a French region surface form (ISO code or name, accents optional) to its ISO code; null
 * if unknown.
 */
export function lookupFrenchRegion(input: string | null | undefined): FrenchRegionCode | null {
	if (!input || typeof input !== "string") return null
	const upper = input.trim().toUpperCase()
	if (REGION_CODE_SET.has(upper)) return upper as FrenchRegionCode
	return FR_REGION_NAME_TO_CODE.get(foldName(input)) ?? null
}
