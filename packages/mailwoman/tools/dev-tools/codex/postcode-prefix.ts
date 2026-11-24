// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The printed forms of the postcode each country's postal operator documents,
 *   where they differ from the one fixed prefix libaddressinput's `fmt` writes
 *   before `%Z`, or where the operator documents more than one form.
 *
 *   Each record cites the operator's UPU Postal Addressing Systems description,
 *   retrieved 2026-11-24, with the sha256 of the PDF, the sentence the forms are
 *   read from and the example lines of each form.
 *   A country absent here prints the prefix its `fmt` states.
 *
 *   A record with two forms is a description that states both: the prefixed form
 *   on mail from abroad and the bare form on domestic mail.
 *   The layout prints the first form, and a corpus writer renders each form in
 *   its share of rows, because the parser reads both.
 *
 *   No description states the share of mail written in each form, so the two forms take equal shares.
 */

/**
 * One printed form of a country's postcode.
 */
interface PostcodeFormRecord {
	/**
	 * The text printed against the postcode, or the empty string when the postcode prints bare.
	 */
	readonly prefix: string
	/**
	 * The share of corpus rows rendered in this form, between 0 and 1.
	 * A country's shares sum to 1.
	 */
	readonly share: number
	/**
	 * Verbatim postcode lines from the description's examples of this form.
	 */
	readonly examples: readonly string[]
}

/**
 * One country's printed postcode forms and the description they're read from.
 */
interface PostcodePrefixRecord {
	/**
	 * The documented forms, the one the layout prints first.
	 */
	readonly forms: readonly PostcodeFormRecord[]
	readonly url: string
	/**
	 * The date in the description's footer, as `YYYY-MM`.
	 */
	readonly documentDate: string
	readonly sha256: string
	/**
	 * The description's sentence that states the forms, verbatim.
	 */
	readonly statement: string
}

const UPU_PAS = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit"

// country-branch: each record is one operator's printed postcode forms, read from its own description.
/**
 * Printed postcode forms keyed by ISO 3166-1 alpha-2.
 */
export const POSTCODE_PREFIX_RECORDS: Readonly<Record<string, PostcodePrefixRecord>> = {
	AI: {
		forms: [{ prefix: "AI-", share: 1, examples: ["The Valley / AI-2640 / ANGUILLA, BWI"] }],
		url: `${UPU_PAS}/aiaEn.pdf`,
		documentDate: "2017-09",
		sha256: "6c7d3ec9cad17c159e4b66d85e319bbef9518edab4f1fde6f2a4bf136b9c8218",
		statement: "6 alphanumeric characters below the name of the locality, with a dash before the numeric part.",
	},
	AX: {
		forms: [{ prefix: "AX-", share: 1, examples: ["AX-22100 MARIEHAMN"] }],
		url: `${UPU_PAS}/alaEn.pdf`,
		documentDate: "2019-02",
		sha256: "4ecbef7cd8b746d75c5d4a04afc8575eb5db56172403137908be719e766c428c",
		statement: 'Finland requests to add the ISO alpha-2 country code "AX" before the postcode.',
	},
	CH: {
		forms: [{ prefix: "", share: 1, examples: ["2544 BETTLACH", "1211 GENEVA 6", "1556 CERNIAZ VD"] }],
		url: `${UPU_PAS}/cheEn.pdf`,
		documentDate: "2024-06",
		sha256: "530a9a37c2b0e953bf2c78e9d61d1d632438b0bbd69d71596b7ae7ffb1ddf7e6",
		statement: "4 digits to the left of locality name.",
	},
	CY: {
		forms: [
			{ prefix: "", share: 0.5, examples: ["6036 Larnaka", "3304 Limassol"] },
			{ prefix: "CY-", share: 0.5, examples: ["CY-2008 Strovolos", "CY-3304 Limassol"] },
		],
		url: `${UPU_PAS}/cypEn.pdf`,
		documentDate: "2023-03",
		sha256: "3ffaf57736cafb95f7d97acd9bd65deac876de8a64c2db038762f026bd26335b",
		statement:
			"Cyprus Post requires the ISO-2 country code to be used on all inbound international mail. " +
			"For domestic mail, the ISO-2 code and country name are not required.",
	},
	FI: {
		forms: [
			{
				prefix: "",
				share: 1,
				examples: ["00550 HELSINKI", "00380 HELSINKI", "50100 MIKKELI", "01620 VANTAA", "00101 HELSINKI"],
			},
		],
		url: `${UPU_PAS}/finEn.pdf`,
		documentDate: "2024-11",
		sha256: "2f1ce8f45d3eb4bc116d49e08458ac5c0bb30d39fda8645fe54996e4c4def754",
		statement: "5 digits to the left of the locality name",
	},
	FO: {
		forms: [{ prefix: "FO-", share: 1, examples: ["FO-100 Tórshavn", "FO-100 TORSHAVN"] }],
		url: `${UPU_PAS}/froEn.pdf`,
		documentDate: "2017-12",
		sha256: "171683b9a9331dc7c6c16132d6217daa9003ab67bf3d728e054b3e6f4224a863",
		statement: "Faroe Islands have a postcode system based on the ISO code alpha-2 (FO) plus 3 digits.",
	},
	HR: {
		forms: [
			{ prefix: "HR-", share: 0.5, examples: ["HR-10000 ZAGREB", "HR-52341 ŽMINJ", "HR-21001 SPLIT"] },
			{ prefix: "", share: 0.5, examples: [] },
		],
		url: `${UPU_PAS}/hrvEn.pdf`,
		documentDate: "2014-05",
		sha256: "695df04065cd708e8431cdd3ee081d66f3bb37c2d9cd1b89f10ddbbe4e2ec642",
		statement:
			"It is required to add the ISO alpha-2 country code “HR” before the postcode separated " +
			"by a dash for mail sent from other countries.",
	},
	HT: {
		forms: [{ prefix: "HT", share: 1, examples: ["HT6120 DELMAS"] }],
		url: `${UPU_PAS}/htiEn.pdf`,
		documentDate: "2017-09",
		sha256: "a4a406e751ed2bd169db92547c1c398b63188f2ba58849018703561c319661a6",
		statement:
			'The Haiti Postal Corporation asks that the country code "HT" be placed before the postcode digits. ' +
			'The "HT" code forms an integral part of the postcode, even for domestic mail.',
	},
	LI: {
		forms: [{ prefix: "", share: 1, examples: ["2544 BETTLACH (cheEn.pdf, 2024-06)"] }],
		url: `${UPU_PAS}/lieEn.pdf`,
		documentDate: "2002-07",
		sha256: "5384521a986e76e6e68532f4fddadcc7fe91bb96a0879a0c1d2c27e462426138",
		statement:
			"Postal services in the Principality of Liechtenstein are operated by Swiss Post ... " +
			"All the information provided for Switzerland therefore applies to Liechtenstein as well.",
	},
	LT: {
		forms: [
			{ prefix: "LT-", share: 0.5, examples: ["LT–04340 Vilnius", "LT–52002 Kaunas"] },
			{ prefix: "", share: 0.5, examples: [] },
		],
		url: `${UPU_PAS}/ltuEn.pdf`,
		documentDate: "2018-06",
		sha256: "88d892eefe71232dbc5ddf4a6750d2ed5f675300f6786c0167ad77844b1d70d2",
		statement:
			"Lithuania Post requires the two character ISO 3166-1 country code to be used on all international " +
			"mail items being delivered to Lithuania. For domestic mail, country code is not required.",
	},
	LU: {
		forms: [{ prefix: "L-", share: 1, examples: ["L-1234 DUDELANGE", "L-9874 REMICH", "L-2998 LUXEMBOURG"] }],
		url: `${UPU_PAS}/luxEn.pdf`,
		documentDate: "2013-06",
		sha256: "294c81d3309097243d7312a7b02958fe0f235f264ce7ccec282ccb71710f105d",
		statement: "4 digits to the left of the locality name and preceded by «L».",
	},
	MC: {
		forms: [{ prefix: "", share: 1, examples: ["98000 MONACO", "98020 MONACO CEDEX"] }],
		url: `${UPU_PAS}/mcoEn.pdf`,
		documentDate: "2004-05",
		sha256: "c7843837a62d54c23d3bdd4946507868a43aa8c6d55c8e1442da4a060955996f",
		statement: "5 digits to the left of the locality name.",
	},
	MD: {
		forms: [{ prefix: "MD-", share: 1, examples: ["MD-2012, CHISINAU"] }],
		url: `${UPU_PAS}/mdaEn.pdf`,
		documentDate: "2019-04",
		sha256: "48420c0a8ec3d20c4ebba4e7b2b133a2d28f834961448be94dae951ffcea058f",
		statement: "4 digits to the left of the locality name and preceded by “MD-”.",
	},
	SE: {
		forms: [{ prefix: "", share: 1, examples: ["123 45 LILLBYN", "111 81 STOCKHOLM", "120 35 TYRESÖ"] }],
		url: `${UPU_PAS}/sweEn.pdf`,
		documentDate: "2024-11",
		sha256: "f91a01689813522df9e00caadda573abdff6d1d9082d1941b90eec93f3bf822b",
		// The examples under "International mail delivered to Sweden" and "Domestic mail" print the same form.
		statement: "5 digits to left of the locality name, with a space between 3rd and 4th digits",
	},
	SI: {
		forms: [{ prefix: "", share: 1, examples: ["4000 KRANJ", "1001 LJUBLJANA", "2500 MARIBOR"] }],
		url: `${UPU_PAS}/svnEn.pdf`,
		documentDate: "2016-05",
		sha256: "9758df597eb7749fe22b8fb7d65ae11aecb695694b19235758eaa218ecc2e9c9",
		statement: "4 digits to the left of the locality name",
	},
}
