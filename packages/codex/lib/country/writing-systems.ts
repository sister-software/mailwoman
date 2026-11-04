// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Generated, so do not edit by hand. The written scripts of each ISO 3166-1 territory's official languages,
 *   derived from Unicode CLDR 47.0.0 supplemental territoryInfo and likelySubtags. A combined ISO 15924
 *   code expands to the Unicode Script property values it covers, so Japanese gives Hani, Hira and Kana.
 *   Regenerate with: node packages/mailwoman/tools/dev-tools/codex/country/writing-systems.run.ts
 *
 *   250 territories by script count:
 *
 *   - 1 script: 223 territories
 *   - 2 scripts: 24 territories
 *   - 3 scripts: 3 territories
 *
 *   Territories with more than one script:
 *
 *   - AZ: Cyrl, Latn
 *   - BA: Cyrl, Latn
 *   - BN: Arab, Latn
 *   - CY: Grek, Latn
 *   - DJ: Arab, Latn
 *   - DZ: Arab, Latn
 *   - ER: Arab, Ethi, Latn
 *   - FJ: Deva, Latn
 *   - HK: Hani, Latn
 *   - IL: Arab, Hebr
 *   - IN: Deva, Latn
 *   - JP: Hani, Hira, Kana
 *   - KM: Arab, Latn
 *   - KP: Hang, Hani
 *   - KR: Hang, Hani
 *   - LK: Sinh, Taml
 *   - MA: Arab, Latn
 *   - MO: Hani, Latn
 *   - PK: Arab, Latn
 *   - RS: Cyrl, Latn
 *   - SD: Arab, Latn
 *   - SG: Hani, Latn, Taml
 *   - SO: Arab, Latn
 *   - TD: Arab, Latn
 *   - TN: Arab, Latn
 *   - UZ: Cyrl, Latn
 *   - XK: Cyrl, Latn
 */

/**
 * A Unicode Script property value that some territory's official language is written in.
 */
export type ScriptCode =
	| "Arab"
	| "Armn"
	| "Beng"
	| "Cyrl"
	| "Deva"
	| "Ethi"
	| "Geor"
	| "Grek"
	| "Hang"
	| "Hani"
	| "Hebr"
	| "Hira"
	| "Kana"
	| "Khmr"
	| "Laoo"
	| "Latn"
	| "Mymr"
	| "Sinh"
	| "Taml"
	| "Thaa"
	| "Thai"
	| "Tibt"

/**
 * Every {@linkcode ScriptCode}, sorted.
 */
export const SCRIPT_CODES: readonly ScriptCode[] = [
	"Arab",
	"Armn",
	"Beng",
	"Cyrl",
	"Deva",
	"Ethi",
	"Geor",
	"Grek",
	"Hang",
	"Hani",
	"Hebr",
	"Hira",
	"Kana",
	"Khmr",
	"Laoo",
	"Latn",
	"Mymr",
	"Sinh",
	"Taml",
	"Thaa",
	"Thai",
	"Tibt",
]

/**
 * ISO 3166-1 alpha-2 → the scripts its official languages are written in, sorted.
 *
 * A territory without an official language in CLDR has no row.
 */
export const COUNTRY_SCRIPTS: Readonly<Record<string, readonly ScriptCode[]>> = {
	AD: ["Latn"],
	AE: ["Arab"],
	AF: ["Arab"],
	AG: ["Latn"],
	AI: ["Latn"],
	AL: ["Latn"],
	AM: ["Armn"],
	AO: ["Latn"],
	AR: ["Latn"],
	AS: ["Latn"],
	AT: ["Latn"],
	AU: ["Latn"],
	AW: ["Latn"],
	AX: ["Latn"],
	AZ: ["Cyrl", "Latn"],
	BA: ["Cyrl", "Latn"],
	BB: ["Latn"],
	BD: ["Beng"],
	BE: ["Latn"],
	BF: ["Latn"],
	BG: ["Cyrl"],
	BH: ["Arab"],
	BI: ["Latn"],
	BJ: ["Latn"],
	BL: ["Latn"],
	BM: ["Latn"],
	BN: ["Arab", "Latn"],
	BO: ["Latn"],
	BQ: ["Latn"],
	BR: ["Latn"],
	BS: ["Latn"],
	BT: ["Tibt"],
	BW: ["Latn"],
	BY: ["Cyrl"],
	BZ: ["Latn"],
	CA: ["Latn"],
	CC: ["Latn"],
	CD: ["Latn"],
	CF: ["Latn"],
	CG: ["Latn"],
	CH: ["Latn"],
	CI: ["Latn"],
	CK: ["Latn"],
	CL: ["Latn"],
	CM: ["Latn"],
	CN: ["Hani"],
	CO: ["Latn"],
	CQ: ["Latn"],
	CR: ["Latn"],
	CU: ["Latn"],
	CV: ["Latn"],
	CW: ["Latn"],
	CX: ["Latn"],
	CY: ["Grek", "Latn"],
	CZ: ["Latn"],
	DE: ["Latn"],
	DG: ["Latn"],
	DJ: ["Arab", "Latn"],
	DK: ["Latn"],
	DM: ["Latn"],
	DO: ["Latn"],
	DZ: ["Arab", "Latn"],
	EA: ["Latn"],
	EC: ["Latn"],
	EE: ["Latn"],
	EG: ["Arab"],
	EH: ["Arab"],
	ER: ["Arab", "Ethi", "Latn"],
	ES: ["Latn"],
	ET: ["Ethi"],
	FI: ["Latn"],
	FJ: ["Deva", "Latn"],
	FK: ["Latn"],
	FM: ["Latn"],
	FO: ["Latn"],
	FR: ["Latn"],
	GA: ["Latn"],
	GB: ["Latn"],
	GD: ["Latn"],
	GE: ["Geor"],
	GF: ["Latn"],
	GG: ["Latn"],
	GH: ["Latn"],
	GI: ["Latn"],
	GL: ["Latn"],
	GM: ["Latn"],
	GN: ["Latn"],
	GP: ["Latn"],
	GQ: ["Latn"],
	GR: ["Grek"],
	GS: ["Latn"],
	GT: ["Latn"],
	GU: ["Latn"],
	GW: ["Latn"],
	GY: ["Latn"],
	HK: ["Hani", "Latn"],
	HN: ["Latn"],
	HR: ["Latn"],
	HT: ["Latn"],
	HU: ["Latn"],
	IC: ["Latn"],
	ID: ["Latn"],
	IE: ["Latn"],
	IL: ["Arab", "Hebr"],
	IM: ["Latn"],
	IN: ["Deva", "Latn"],
	IO: ["Latn"],
	IQ: ["Arab"],
	IR: ["Arab"],
	IS: ["Latn"],
	IT: ["Latn"],
	JE: ["Latn"],
	JM: ["Latn"],
	JO: ["Arab"],
	JP: ["Hani", "Hira", "Kana"],
	KE: ["Latn"],
	KG: ["Cyrl"],
	KH: ["Khmr"],
	KI: ["Latn"],
	KM: ["Arab", "Latn"],
	KN: ["Latn"],
	KP: ["Hang", "Hani"],
	KR: ["Hang", "Hani"],
	KW: ["Arab"],
	KY: ["Latn"],
	KZ: ["Cyrl"],
	LA: ["Laoo"],
	LB: ["Arab"],
	LC: ["Latn"],
	LI: ["Latn"],
	LK: ["Sinh", "Taml"],
	LR: ["Latn"],
	LS: ["Latn"],
	LT: ["Latn"],
	LU: ["Latn"],
	LV: ["Latn"],
	LY: ["Arab"],
	MA: ["Arab", "Latn"],
	MC: ["Latn"],
	MD: ["Latn"],
	ME: ["Latn"],
	MF: ["Latn"],
	MG: ["Latn"],
	MH: ["Latn"],
	MK: ["Cyrl"],
	ML: ["Latn"],
	MM: ["Mymr"],
	MN: ["Cyrl"],
	MO: ["Hani", "Latn"],
	MP: ["Latn"],
	MQ: ["Latn"],
	MR: ["Arab"],
	MS: ["Latn"],
	MT: ["Latn"],
	MU: ["Latn"],
	MV: ["Thaa"],
	MW: ["Latn"],
	MX: ["Latn"],
	MY: ["Latn"],
	MZ: ["Latn"],
	NA: ["Latn"],
	NC: ["Latn"],
	NE: ["Latn"],
	NF: ["Latn"],
	NG: ["Latn"],
	NI: ["Latn"],
	NL: ["Latn"],
	NO: ["Latn"],
	NP: ["Deva"],
	NR: ["Latn"],
	NU: ["Latn"],
	NZ: ["Latn"],
	OM: ["Arab"],
	PA: ["Latn"],
	PE: ["Latn"],
	PF: ["Latn"],
	PG: ["Latn"],
	PH: ["Latn"],
	PK: ["Arab", "Latn"],
	PL: ["Latn"],
	PM: ["Latn"],
	PN: ["Latn"],
	PR: ["Latn"],
	PS: ["Arab"],
	PT: ["Latn"],
	PW: ["Latn"],
	PY: ["Latn"],
	QA: ["Arab"],
	RE: ["Latn"],
	RO: ["Latn"],
	RS: ["Cyrl", "Latn"],
	RU: ["Cyrl"],
	RW: ["Latn"],
	SA: ["Arab"],
	SB: ["Latn"],
	SC: ["Latn"],
	SD: ["Arab", "Latn"],
	SE: ["Latn"],
	SG: ["Hani", "Latn", "Taml"],
	SH: ["Latn"],
	SI: ["Latn"],
	SJ: ["Latn"],
	SK: ["Latn"],
	SL: ["Latn"],
	SM: ["Latn"],
	SN: ["Latn"],
	SO: ["Arab", "Latn"],
	SR: ["Latn"],
	SS: ["Latn"],
	ST: ["Latn"],
	SV: ["Latn"],
	SX: ["Latn"],
	SY: ["Arab"],
	SZ: ["Latn"],
	TC: ["Latn"],
	TD: ["Arab", "Latn"],
	TG: ["Latn"],
	TH: ["Thai"],
	TJ: ["Cyrl"],
	TK: ["Latn"],
	TL: ["Latn"],
	TM: ["Latn"],
	TN: ["Arab", "Latn"],
	TO: ["Latn"],
	TR: ["Latn"],
	TT: ["Latn"],
	TV: ["Latn"],
	TW: ["Hani"],
	TZ: ["Latn"],
	UA: ["Cyrl"],
	UG: ["Latn"],
	UM: ["Latn"],
	US: ["Latn"],
	UY: ["Latn"],
	UZ: ["Cyrl", "Latn"],
	VA: ["Latn"],
	VC: ["Latn"],
	VE: ["Latn"],
	VG: ["Latn"],
	VI: ["Latn"],
	VN: ["Latn"],
	VU: ["Latn"],
	WF: ["Latn"],
	WS: ["Latn"],
	XK: ["Cyrl", "Latn"],
	YE: ["Arab"],
	YT: ["Latn"],
	ZA: ["Latn"],
	ZM: ["Latn"],
	ZW: ["Latn"],
}
