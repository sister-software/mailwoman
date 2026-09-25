/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Corroborates an EDGAR name match with the registrant's SIC code or an explicit CIK pin.
 *   A high name score alone can pick an unrelated company, such as WidePoint (SIC 7373) for "WideOpenWest".
 *   The SIC list stays narrow for that reason. Carriers filed under other codes, such as Bandwidth (7372),
 *   need a pin instead. A failed check leaves the match unconfirmed rather than disproving it.
 */

import type { CIK } from "#sdk/edgar/filings/index"

/**
 * SIC codes that corroborate a telecom match.
 */
export const TELECOM_SIC_CODES: ReadonlySet<string> = new Set([
	"4812", // Radiotelephone communications.
	"4813", // Telephone communications other than radiotelephone. Most ILECs and CLECs file here.
	"4822", // Telegraph and other message communications.
	"4832", // Radio broadcasting stations.
	"4833", // Television broadcasting stations.
	"4841", // Cable and other pay television services.
	"4899", // Communications services not elsewhere classified. Satellite and in-flight providers file here.
])

/**
 * Reason a candidate passed or failed corroboration.
 */
export const CIKCorroborationBasis = {
	/**
	 * The registrant's SIC is in the accepted set.
	 */
	TelecomSIC: "telecom-sic",
	/**
	 * The caller pinned this CIK, so the SIC was skipped.
	 */
	Pinned: "pinned",
	/**
	 * The registrant's SIC is outside the accepted set.
	 */
	NonTelecomSIC: "non-telecom-sic",
	/**
	 * EDGAR returned no SIC.
	 */
	NoSIC: "no-sic",
} as const

/**
 * Union of the {@link CIKCorroborationBasis} values.
 */
export type CIKCorroborationBasis = (typeof CIKCorroborationBasis)[keyof typeof CIKCorroborationBasis]

/**
 * Result of {@link corroborateCIK}.
 */
export interface CIKCorroborationVerdict {
	corroborated: boolean
	basis: CIKCorroborationBasis
	/**
	 * The trimmed SIC that was checked, if any.
	 */
	sic?: string
}

/**
 * Options for {@link corroborateCIK}.
 */
export interface CIKCorroborationOptions {
	/**
	 * CIKs accepted without an SIC check.
	 */
	pinnedCIKs?: ReadonlySet<string>
	/**
	 * Accepted SIC codes.
	 * The default is {@linkcode TELECOM_SIC_CODES}.
	 */
	acceptedSICCodes?: ReadonlySet<string>
}

/**
 * Corroborates a name-matched CIK by its SIC code or a pin.
 * The name score plays no part.
 */
export function corroborateCIK(
	cik: CIK,
	sic: string | null | undefined,
	options: CIKCorroborationOptions = {}
): CIKCorroborationVerdict {
	if (options.pinnedCIKs?.has(cik)) {
		return { corroborated: true, basis: CIKCorroborationBasis.Pinned }
	}

	const trimmed = (sic ?? "").trim()

	if (!trimmed) {
		return { corroborated: false, basis: CIKCorroborationBasis.NoSIC }
	}

	const accepted = options.acceptedSICCodes ?? TELECOM_SIC_CODES

	return accepted.has(trimmed)
		? { corroborated: true, basis: CIKCorroborationBasis.TelecomSIC, sic: trimmed }
		: { corroborated: false, basis: CIKCorroborationBasis.NonTelecomSIC, sic: trimmed }
}
