/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Records per-country street-line conventions that libaddressinput's opaque `%A` street slot does not describe.
 */

/**
 * Describes whether the house number precedes or follows the street name.
 */
export type StreetOrder = "number-first" | "number-last"

/**
 * Lists the countries that separate the street name and house number with a comma, as in `Calle Mayor, 12`.
 *
 * The list comes from the OpenCage `address-formatting` templates, the same source as `STREET_ORDERS`.
 * Spain's corpus recipe renders both forms.
 * Its `nativeHouseJoin` option collapses the comma.
 */
export const COMMA_JOINED_STREET_COUNTRIES: ReadonlySet<string> = new Set([
	"BJ",
	"BN",
	"BR",
	"BY",
	"CD",
	"CG",
	"ES",
	"IN",
	"KG",
	"KZ",
	"LA",
	"MD",
	"MR",
	"MU",
	"MZ",
	"RU",
	// San Marino writes the comma where Italy, which surrounds it, writes none.
	// Measured on its own institutions' published addresses: `Via del Voltone, 120` from the central
	// bank, `Contrada Omerelli, 20` and `Viale Antonio Onofri, 87` from the state university.
	"SM",
	"SY",
	"TG",
	"TM",
	"UA",
	"XK",
	"YE",
])

/**
 * Maps a country to the codex street node for its own script, when that differs
 * from its romanized street line.
 *
 * `STREET_ORDERS` describes the romanized form.
 * Hong Kong writes `21 Jordan Road` in Latin script and `佐敦道21號` in Chinese.
 * Neither order can be derived from the other.
 *
 * `han` is the unseparated name-then-number line that Chinese-writing systems use.
 * A country absent from this table uses one street order in every script.
 */
export const LOCAL_STREET_NODES: Readonly<Record<string, "han">> = {
	CN: "han",
	HK: "han",
	MO: "han",
	TW: "han",
}

/**
 * Maps an ISO 3166-1 alpha-2 code to its street order.
 *
 * The values come from the OpenCage `address-formatting` templates (MIT)
 * and are committed as data, so no third-party package loads at run time.
 * A country is absent when its template lacks either slot.
 *
 * The layout generator in `@mailwoman/codex/address/layouts` then defaults to number-first.
 *
 * **That default is silent, and it is wrong for a dependency of a number-last state.**
 * 41 of the register's 250 jurisdictions state no order here.
 * Most take the default correctly, because their sovereign is also number-first: the French
 * territories under `FR`, the US ones under `US`, the Crown dependencies under `GB`, and Canada.
 *
 * `AX`, `BQ`, `LI`, `SJ` and `SM` are stated below because their sovereigns
 * or neighbors read number-last, so the default reversed them.
 * Each entry's comment quotes the published addresses it was read from.
 *
 * **`VA` is left unstated deliberately.** The Vatican's interior addressing uses a building
 * or courtyard name with the postcode and no number, as `Cortile Belvedere`
 * and `Via del Pellegrino, 00120 Città del Vaticano` do.
 * A street with a number appears only on the Roman streets of its extraterritorial buildings,
 * `Via della Conciliazione 54` and `Piazza Pia 3`, which exercises Italy's order rather than the Vatican's.
 *
 * An entry here needs a published address that exercises the order, and the addresses read so far do not.
 *
 * To refresh the table, read each country's `address_template` from `templates.json`.
 * Collapse each `{{#first}}` alternation to the `{{{road}}}` it contains,
 * because a road inside an alternation is a fallback for a place name.
 *
 * Then compare the offsets of `{{{house_number}}}` and `{{{road}}}`.
 */
export const STREET_ORDERS: Readonly<Record<string, StreetOrder>> = {
	AD: "number-first",
	AE: "number-first",
	AF: "number-last",
	AG: "number-first",
	AI: "number-last",
	AL: "number-last",
	AM: "number-first",
	AO: "number-last",
	AR: "number-last",
	AT: "number-last",
	AU: "number-first",
	AW: "number-last",
	// Åland is Finnish territory under Finnish postal rules, and `FI` reads `number-last`.
	// OpenCage states no template for it, and the generator's fallback would write
	// `number-first`, which is the mainland's order reversed.
	AX: "number-last",
	AZ: "number-first",
	BA: "number-last",
	BB: "number-first",
	BD: "number-first",
	BE: "number-last",
	BF: "number-first",
	BG: "number-last",
	BH: "number-first",
	BI: "number-last",
	BJ: "number-first",
	BM: "number-first",
	BN: "number-first",
	BO: "number-last",
	// Measured across all three islands, which each have their own government and land
	// registry: `Kaya Irlanda 17` and `Kaya Grandi 30` on Bonaire, `Fort Oranjestraat #5`
	// and `Kennip Road 11` on Sint Eustatius, `Paris Hill Road 10` and `Powerstreet 1` on Saba.
	// Ten numbered addresses agreed and none put the number first.
	// Sint Eustatius writes a `#` before the number, which is a prefix rather than an order.
	// This entry is correct and currently inert: libaddressinput states no `fmt` for `BQ`,
	// so the generator emits no layout and `formatAddressRow` answers `null` for it,
	// as it does for `AW`, `CW` and `SX`.
	// No source in those four jurisdictions is ingest-eligible, so no row depends on it yet.
	BQ: "number-last",
	BR: "number-last",
	BS: "number-last",
	BT: "number-last",
	BW: "number-last",
	BY: "number-last",
	BZ: "number-first",
	CD: "number-first",
	CF: "number-last",
	CG: "number-first",
	CH: "number-last",
	CI: "number-first",
	CK: "number-first",
	CL: "number-last",
	CM: "number-last",
	CN: "number-last",
	CO: "number-last",
	CR: "number-last",
	CU: "number-last",
	CV: "number-last",
	CW: "number-last",
	CY: "number-last",
	CZ: "number-last",
	DE: "number-last",
	DJ: "number-first",
	DK: "number-last",
	DM: "number-first",
	DO: "number-last",
	DZ: "number-first",
	EC: "number-last",
	EE: "number-last",
	EG: "number-first",
	EH: "number-last",
	ER: "number-last",
	ES: "number-last",
	ET: "number-last",
	FI: "number-last",
	FJ: "number-first",
	FM: "number-first",
	FO: "number-last",
	FR: "number-first",
	GA: "number-first",
	GB: "number-first",
	GD: "number-last",
	GE: "number-last",
	GH: "number-first",
	GI: "number-first",
	GL: "number-last",
	GM: "number-first",
	GN: "number-first",
	GQ: "number-last",
	GR: "number-last",
	GT: "number-last",
	GW: "number-last",
	GY: "number-first",
	HK: "number-first",
	HN: "number-last",
	HR: "number-last",
	HT: "number-last",
	HU: "number-last",
	ID: "number-last",
	IE: "number-first",
	IL: "number-last",
	IN: "number-first",
	IQ: "number-first",
	IR: "number-last",
	IS: "number-last",
	IT: "number-last",
	JM: "number-first",
	JO: "number-last",
	JP: "number-first",
	KE: "number-first",
	KG: "number-last",
	KH: "number-first",
	KI: "number-last",
	KM: "number-last",
	KN: "number-first",
	KP: "number-last",
	KR: "number-last",
	KW: "number-last",
	KY: "number-first",
	KZ: "number-last",
	LA: "number-first",
	LB: "number-first",
	LC: "number-last",
	// Measured on the national postal operator's own address, `Alte Zollstrasse 11, 9494 Schaan`,
	// and agreeing across the government, the parliament, the courts, the national hospital
	// and the Landesbank: `Peter-Kaiser-Platz 1`, `Spaniagasse 1`, `Heiligkreuz 25`, `Städtle 44`.
	LI: "number-last",
	LK: "number-first",
	LR: "number-last",
	LS: "number-first",
	LT: "number-last",
	LU: "number-first",
	LV: "number-last",
	LY: "number-last",
	MA: "number-first",
	MC: "number-first",
	MD: "number-last",
	ME: "number-last",
	MG: "number-first",
	MH: "number-first",
	MK: "number-last",
	ML: "number-last",
	MM: "number-first",
	MN: "number-last",
	MO: "number-last",
	MR: "number-first",
	MS: "number-first",
	MT: "number-first",
	MU: "number-first",
	MV: "number-first",
	MW: "number-first",
	MX: "number-last",
	MY: "number-first",
	MZ: "number-last",
	NA: "number-first",
	NE: "number-first",
	NG: "number-first",
	NI: "number-last",
	NL: "number-last",
	NO: "number-last",
	NP: "number-last",
	NR: "number-first",
	NU: "number-first",
	NZ: "number-first",
	OM: "number-first",
	PA: "number-last",
	PE: "number-last",
	PG: "number-first",
	PH: "number-first",
	PK: "number-first",
	PL: "number-last",
	PT: "number-last",
	PW: "number-last",
	PY: "number-last",
	QA: "number-last",
	RO: "number-last",
	RS: "number-last",
	RU: "number-last",
	RW: "number-first",
	SA: "number-first",
	SB: "number-last",
	SC: "number-first",
	SD: "number-last",
	SE: "number-last",
	SG: "number-first",
	SI: "number-last",
	// Measured rather than inherited: Kartverket's own `adresseTekst` column reads `Vei 223 8`
	// and `Vei 500 1` for Longyearbyen, so Svalbard writes the street before the number as Norway does.
	// OpenCage states no template for it, and the generator's fallback would write `8 Vei 223`.
	SJ: "number-last",
	SK: "number-last",
	SL: "number-first",
	// Measured on the central bank, the state university, the social-security institute
	// and the state public-works agency: `Via del Voltone, 120`, `Contrada Omerelli, 20`,
	// `Via Scialoja, 20`, `Strada del Lavoro, 75`.
	// San Marino also writes a comma between the street and the number, so it is in
	// {@linkcode COMMA_JOINED_STREET_COUNTRIES} as well, which Italy is not.
	SM: "number-last",
	SN: "number-first",
	SO: "number-last",
	SR: "number-last",
	SS: "number-last",
	ST: "number-last",
	SV: "number-last",
	SX: "number-last",
	SY: "number-last",
	SZ: "number-last",
	TC: "number-first",
	TD: "number-last",
	TG: "number-first",
	TH: "number-first",
	TJ: "number-last",
	TL: "number-last",
	TM: "number-first",
	TN: "number-first",
	TO: "number-first",
	TR: "number-last",
	TT: "number-first",
	TV: "number-first",
	TW: "number-last",
	TZ: "number-first",
	UA: "number-last",
	UG: "number-first",
	US: "number-first",
	UY: "number-last",
	UZ: "number-last",
	VC: "number-last",
	VE: "number-last",
	VG: "number-first",
	VN: "number-first",
	VU: "number-last",
	WS: "number-last",
	XC: "number-first",
	XK: "number-first",
	YE: "number-first",
	ZA: "number-first",
	ZM: "number-first",
	ZW: "number-first",
}
