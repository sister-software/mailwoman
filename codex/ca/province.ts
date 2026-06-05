/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The 13 Canadian provinces and territories (10 provinces + 3 territories), keyed by their ISO
 *   3166-2:CA code.
 *
 *   The informative contrast with `de/bundesland.ts` and `us/state.ts`: a Canadian subdivision is
 *   officially BILINGUAL, so each unit carries two equally-canonical names — an English one and a
 *   French one — and the gap between them is wide (`Nova Scotia` / `Nouvelle-Écosse`, `British
 *   Columbia` / `Colombie-Britannique`). That mirrors the German English-exonym pattern (`Bavaria`
 *   / `Bayern`), except here the French name is not a foreign exonym but a co-official form a real
 *   address can be written in. And like a US two-letter state code, the ISO code (`ON`, `QC`, `BC`)
 *   is the abbreviation people actually write on the address line — so unlike German or French
 *   regions, the Canadian code IS a surface form, not just a resolver key.
 */

/** Per-province record: ISO 3166-2:CA code, English name, and the co-official French name. */
export interface CanadianProvinceInfo {
	/** ISO 3166-2:CA subdivision code without the `CA-` prefix (e.g. `ON` for `CA-ON`). */
	code: string
	/** English name (e.g. `Quebec`). */
	name: string
	/** Co-official French name (e.g. `Québec`). */
	french: string
}

/**
 * ISO 3166-2:CA code → province/territory info, for all 13 subdivisions (10 provinces + 3
 * territories). Codes are the official subdivision codes minus the `CA-` prefix.
 */
export const CA_PROVINCES = {
	AB: { code: "AB", name: "Alberta", french: "Alberta" },
	BC: { code: "BC", name: "British Columbia", french: "Colombie-Britannique" },
	MB: { code: "MB", name: "Manitoba", french: "Manitoba" },
	NB: { code: "NB", name: "New Brunswick", french: "Nouveau-Brunswick" },
	NL: { code: "NL", name: "Newfoundland and Labrador", french: "Terre-Neuve-et-Labrador" },
	NS: { code: "NS", name: "Nova Scotia", french: "Nouvelle-Écosse" },
	NT: { code: "NT", name: "Northwest Territories", french: "Territoires du Nord-Ouest" },
	NU: { code: "NU", name: "Nunavut", french: "Nunavut" },
	ON: { code: "ON", name: "Ontario", french: "Ontario" },
	PE: { code: "PE", name: "Prince Edward Island", french: "Île-du-Prince-Édouard" },
	QC: { code: "QC", name: "Quebec", french: "Québec" },
	SK: { code: "SK", name: "Saskatchewan", french: "Saskatchewan" },
	YT: { code: "YT", name: "Yukon", french: "Yukon" },
} as const satisfies Record<string, CanadianProvinceInfo>

/** An ISO 3166-2:CA province/territory code (`AB`, `ON`, `QC`, …). */
export type CanadianProvinceCode = keyof typeof CA_PROVINCES

const PROVINCE_CODE_SET: ReadonlySet<string> = new Set(Object.keys(CA_PROVINCES))

/** Type-predicate for an ISO 3166-2:CA province/territory code. Case-insensitive. */
export function isCanadianProvinceCode(input: unknown): input is CanadianProvinceCode {
	return typeof input === "string" && PROVINCE_CODE_SET.has(input.toUpperCase())
}

/** Strip diacritics + lowercase so `Québec`, `Quebec`, and `quebec` all key alike. */
function foldName(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
}

/**
 * Folded province name (English or French) / code → ISO 3166-2:CA code. Built diacritic-insensitive
 * so both co-official names map regardless of accents: `Québec`, `Quebec`, and an unaccented
 * `Nouvelle-Ecosse` all resolve. The two-name design is the Canadian wrinkle — unlike the German
 * lookup's English exonym, the French form here is a name a real address may legitimately use.
 */
export const CA_PROVINCE_NAME_TO_CODE: ReadonlyMap<string, CanadianProvinceCode> = (() => {
	const out = new Map<string, CanadianProvinceCode>()
	for (const code of Object.keys(CA_PROVINCES) as CanadianProvinceCode[]) {
		const info = CA_PROVINCES[code]
		out.set(foldName(info.name), code)
		out.set(foldName(info.french), code)
		out.set(code.toLowerCase(), code)
	}
	return out
})()

/**
 * Resolve a Canadian province/territory surface form (ISO code, English name, or French name,
 * accents optional) to its ISO code; null if unknown.
 */
export function lookupCanadianProvince(input: string | null | undefined): CanadianProvinceCode | null {
	if (!input || typeof input !== "string") return null
	const upper = input.trim().toUpperCase()
	if (PROVINCE_CODE_SET.has(upper)) return upper as CanadianProvinceCode
	return CA_PROVINCE_NAME_TO_CODE.get(foldName(input)) ?? null
}
