/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reserved bare-postcode capability cases. These strings are excluded from every country in the
 *   training recipe and are read only by evaluation. Reservation is by normalized input string,
 *   because `NNN NN` is shared by CZ, SK, SE and GR; excluding a Czech row alone could still train
 *   the model on the identical Swedish input.
 */

export type BarePostcodeEvalFamily = "nnn_nn" | "nnnn_ll"

export interface BarePostcodeEvalCase {
	input: string
	country: "CZ" | "NL" | "SK"
	family: BarePostcodeEvalFamily
}

const SPACED_FIVE_CZ = [
	"120 00",
	"130 00",
	"140 00",
	"150 00",
	"160 00",
	"170 00",
	"180 00",
	"190 00",
	"602 00",
	"603 00",
	"612 00",
	"616 00",
	"621 00",
	"628 00",
	"635 00",
	"639 00",
	"702 00",
	"708 00",
	"710 00",
	"721 00",
	"779 00",
	"746 01",
	"747 05",
	"750 02",
] as const

const SPACED_FIVE_SK = ["811 02", "821 01", "831 02", "841 01", "851 01", "949 01", "974 01", "010 01"] as const

const DUTCH = [
	"1011 AB",
	"1013 BG",
	"1015 CJ",
	"1017 DK",
	"1018 EL",
	"1052 GM",
	"1053 HN",
	"1054 JP",
	"2011 KR",
	"2012 LS",
	"2511 MT",
	"2513 NV",
	"3011 PW",
	"3012 RX",
	"3511 SA",
	"3512 TB",
	"4811 VC",
	"5611 WD",
	"6211 XE",
	"6511 ZF",
	"7511 AG",
	"8011 BH",
	"9711 CJ",
	"9712 DK",
] as const

/**
 * The 56 postcode strings measured across v5.0.0 through v5.5.0 and reserved from later training.
 */
export const BARE_POSTCODE_EVAL_CASES: readonly BarePostcodeEvalCase[] = [
	...SPACED_FIVE_CZ.map((input) => ({ input, country: "CZ" as const, family: "nnn_nn" as const })),
	...SPACED_FIVE_SK.map((input) => ({ input, country: "SK" as const, family: "nnn_nn" as const })),
	...DUTCH.map((input) => ({ input, country: "NL" as const, family: "nnnn_ll" as const })),
]

/**
 * Normalize the model-visible postcode value for reservation checks.
 */
export function normalizeBarePostcodeSurface(surface: string): string {
	return surface.trim().toUpperCase().replaceAll(/\s+/gu, "")
}

const RESERVED_SURFACES = new Set(BARE_POSTCODE_EVAL_CASES.map(({ input }) => normalizeBarePostcodeSurface(input)))

/**
 * Whether a postcode string is reserved exclusively for the capability evaluation.
 */
export function isReservedBarePostcode(surface: string): boolean {
	return RESERVED_SURFACES.has(normalizeBarePostcodeSurface(surface))
}
