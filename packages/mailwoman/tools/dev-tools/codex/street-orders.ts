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
 * `AX` and `SJ` are stated below because their sovereigns read number-last, so the default
 * reversed them. **`BQ`, `LI`, `SM` and `VA` are the remaining suspects.** Each is a dependency
 * or enclave of a number-last state, namely `NL`, `CH` and `IT`, and each still takes the default.
 * None has been checked against a published address, which is what an entry here needs.
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
