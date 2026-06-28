/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The 16 German federal states (Bundesländer), keyed by their ISO 3166-2:DE subdivision code.
 *
 *   The US analog is `us/state.ts`. The informative difference: a US state's two-letter code (`CA`)
 *   is the USPS abbreviation people actually write in an address, whereas a German address almost
 *   never carries the Bundesland at all — it is `PLZ City`, and the state is inferred. So these
 *   codes matter for resolver region-matching and display, not for parsing the surface string.
 */

/** Per-state record: ISO 3166-2:DE code, native German name, and the common English exonym. */
export interface GermanStateInfo {
	/** ISO 3166-2:DE subdivision code without the `DE-` prefix (e.g. `BY` for `DE-BY`). */
	code: string
	/** Native German name (e.g. `Bayern`). */
	name: string
	/** Common English name (e.g. `Bavaria`). */
	english: string
}

/**
 * ISO 3166-2:DE code → state info, for all 16 Bundesländer. Codes are the official subdivision codes minus the `DE-`
 * prefix.
 */
export const DE_BUNDESLAENDER = {
	BW: { code: "BW", name: "Baden-Württemberg", english: "Baden-Württemberg" },
	BY: { code: "BY", name: "Bayern", english: "Bavaria" },
	BE: { code: "BE", name: "Berlin", english: "Berlin" },
	BB: { code: "BB", name: "Brandenburg", english: "Brandenburg" },
	HB: { code: "HB", name: "Bremen", english: "Bremen" },
	HH: { code: "HH", name: "Hamburg", english: "Hamburg" },
	HE: { code: "HE", name: "Hessen", english: "Hesse" },
	MV: { code: "MV", name: "Mecklenburg-Vorpommern", english: "Mecklenburg-Western Pomerania" },
	NI: { code: "NI", name: "Niedersachsen", english: "Lower Saxony" },
	NW: { code: "NW", name: "Nordrhein-Westfalen", english: "North Rhine-Westphalia" },
	RP: { code: "RP", name: "Rheinland-Pfalz", english: "Rhineland-Palatinate" },
	SL: { code: "SL", name: "Saarland", english: "Saarland" },
	SN: { code: "SN", name: "Sachsen", english: "Saxony" },
	ST: { code: "ST", name: "Sachsen-Anhalt", english: "Saxony-Anhalt" },
	SH: { code: "SH", name: "Schleswig-Holstein", english: "Schleswig-Holstein" },
	TH: { code: "TH", name: "Thüringen", english: "Thuringia" },
} as const satisfies Record<string, GermanStateInfo>

/** An ISO 3166-2:DE state code (`BW`, `BY`, `BE`, …). */
export type GermanStateCode = keyof typeof DE_BUNDESLAENDER

const STATE_CODE_SET: ReadonlySet<string> = new Set(Object.keys(DE_BUNDESLAENDER))

/** Type-predicate for an ISO 3166-2:DE state code. Case-insensitive. */
export function isGermanStateCode(input: unknown): input is GermanStateCode {
	return typeof input === "string" && STATE_CODE_SET.has(input.toUpperCase())
}

/**
 * Name (native German, English exonym, or common alias) → ISO 3166-2:DE code, lowercase-keyed. Includes the everyday
 * aliases a parser actually meets: `NRW` for Nordrhein-Westfalen, `Bavaria` for Bayern, `Saxony` for Sachsen. The point
 * is resolver region-matching: a German parse emits a region surface form, and the eval needs to map it to a code
 * without a US-USPS-shaped matcher.
 */
export const DE_STATE_NAME_TO_CODE: ReadonlyMap<string, GermanStateCode> = (() => {
	const out = new Map<string, GermanStateCode>()

	for (const code of Object.keys(DE_BUNDESLAENDER) as GermanStateCode[]) {
		const info = DE_BUNDESLAENDER[code]
		out.set(info.name.toLowerCase(), code)
		out.set(info.english.toLowerCase(), code)
		out.set(code.toLowerCase(), code)
	}
	// Everyday aliases that are neither the ISO code nor the canonical name.
	const aliases: Record<string, GermanStateCode> = {
		nrw: "NW",
		"nordrhein westfalen": "NW",
		"baden wurttemberg": "BW",
		"baden-wuerttemberg": "BW",
		"baden wuerttemberg": "BW",
		thueringen: "TH",
		"freie hansestadt bremen": "HB",
		"freie und hansestadt hamburg": "HH",
	}

	for (const [alias, code] of Object.entries(aliases)) out.set(alias, code)

	return out
})()

/**
 * Resolve a German state surface form (code, German name, English name, or common alias) to its ISO 3166-2:DE code.
 * Returns null when unrecognized.
 */
export function lookupGermanState(input: string | null | undefined): GermanStateCode | null {
	if (!input || typeof input !== "string") return null
	const key = input.trim().toLowerCase()

	if (STATE_CODE_SET.has(key.toUpperCase())) return key.toUpperCase() as GermanStateCode

	return DE_STATE_NAME_TO_CODE.get(key) ?? null
}
