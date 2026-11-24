// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The countries whose postal operator prints the postcode with a different fixed
 *   prefix from the one libaddressinput's `fmt` writes before `%Z`.
 *
 *   Each record cites the operator's UPU Postal Addressing Systems description, retrieved
 *   2026-11-24, with the sha256 of the PDF and the example lines the prefix is read from.
 *   A country absent here prints the prefix its `fmt` states.
 *
 *   The descriptions for Croatia (`HR-`), Lithuania (`LT-`), Luxembourg (`L-`), Moldova (`MD-`)
 *   and Åland (`AX-`) print that same prefix in every example, and Cyprus's prints `CY-`
 *   only on inbound international mail, so its `fmt` without one is the domestic form.
 */

/**
 * One country's printed postcode prefix and the description it's read from.
 */
interface PostcodePrefixRecord {
	/**
	 * The text printed against the postcode, or the empty string when the postcode prints bare.
	 */
	readonly prefix: string
	readonly url: string
	/**
	 * The date in the description's footer, as `YYYY-MM`.
	 */
	readonly documentDate: string
	readonly sha256: string
	/**
	 * Verbatim postcode lines from the description's examples.
	 */
	readonly examples: readonly string[]
}

const UPU_PAS = "https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit"

// country-branch: each record is one operator's printed postcode form, read from its own description.
/**
 * Printed postcode prefixes that replace the `fmt` literal, keyed by ISO 3166-1 alpha-2.
 */
export const POSTCODE_PREFIX_RECORDS: Readonly<Record<string, PostcodePrefixRecord>> = {
	// "6 alphanumeric characters below the name of the locality, with a dash before the numeric part."
	AI: {
		prefix: "AI-",
		url: `${UPU_PAS}/aiaEn.pdf`,
		documentDate: "2017-09",
		sha256: "6c7d3ec9cad17c159e4b66d85e319bbef9518edab4f1fde6f2a4bf136b9c8218",
		examples: ["The Valley / AI-2640 / ANGUILLA, BWI"],
	},
	// "4 digits to the left of locality name."
	CH: {
		prefix: "",
		url: `${UPU_PAS}/cheEn.pdf`,
		documentDate: "2024-06",
		sha256: "530a9a37c2b0e953bf2c78e9d61d1d632438b0bbd69d71596b7ae7ffb1ddf7e6",
		examples: ["2544 BETTLACH", "1211 GENEVA 6", "1556 CERNIAZ VD"],
	},
	// "5 digits to the left of the locality name"
	FI: {
		prefix: "",
		url: `${UPU_PAS}/finEn.pdf`,
		documentDate: "2024-11",
		sha256: "2f1ce8f45d3eb4bc116d49e08458ac5c0bb30d39fda8645fe54996e4c4def754",
		examples: ["00550 HELSINKI", "00380 HELSINKI", "50100 MIKKELI", "01620 VANTAA", "00101 HELSINKI"],
	},
	// "a postcode system based on the ISO code alpha-2 (FO) plus 3 digits", printed with a hyphen.
	FO: {
		prefix: "FO-",
		url: `${UPU_PAS}/froEn.pdf`,
		documentDate: "2017-12",
		sha256: "171683b9a9331dc7c6c16132d6217daa9003ab67bf3d728e054b3e6f4224a863",
		examples: ["FO-100 Tórshavn", "FO-100 TORSHAVN"],
	},
	// "Postal services in the Principality of Liechtenstein are operated by Swiss Post ...
	// All the information provided for Switzerland therefore applies to Liechtenstein as well."
	// The Swiss examples print no prefix.
	LI: {
		prefix: "",
		url: `${UPU_PAS}/lieEn.pdf`,
		documentDate: "2002-07",
		sha256: "5384521a986e76e6e68532f4fddadcc7fe91bb96a0879a0c1d2c27e462426138",
		examples: ["2544 BETTLACH (cheEn.pdf, 2024-06)"],
	},
	// "5 digits to the left of the locality name."
	MC: {
		prefix: "",
		url: `${UPU_PAS}/mcoEn.pdf`,
		documentDate: "2004-05",
		sha256: "c7843837a62d54c23d3bdd4946507868a43aa8c6d55c8e1442da4a060955996f",
		examples: ["98000 MONACO", "98020 MONACO CEDEX"],
	},
	// "5 digits to left of the locality name, with a space between 3rd and 4th digits",
	// in international and domestic mail.
	SE: {
		prefix: "",
		url: `${UPU_PAS}/sweEn.pdf`,
		documentDate: "2024-11",
		sha256: "f91a01689813522df9e00caadda573abdff6d1d9082d1941b90eec93f3bf822b",
		examples: ["123 45 LILLBYN", "111 81 STOCKHOLM", "120 35 TYRESÖ"],
	},
	// "4 digits to the left of the locality name"
	SI: {
		prefix: "",
		url: `${UPU_PAS}/svnEn.pdf`,
		documentDate: "2016-05",
		sha256: "9758df597eb7749fe22b8fb7d65ae11aecb695694b19235758eaa218ecc2e9c9",
		examples: ["4000 KRANJ", "1001 LJUBLJANA", "2500 MARIBOR"],
	},
}
