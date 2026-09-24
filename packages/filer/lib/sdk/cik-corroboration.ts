/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Corroborate EDGAR name matches with the registrant's SIC or an explicit CIK pin.
 *   On 2026-08-03, selecting the top name-score match for 24 telecom registrants returned two wrong companies:
 *
 *   | query                  | resolved to                                | score |
 *   | ---------------------- | ------------------------------------------ | ----- |
 *   | `Altice USA, Inc.`     | AlTi Global, Inc. — SIC 6282, investment advice | 0.829 |
 *   | `WideOpenWest, Inc.`   | WidePoint Corp — SIC 7373, systems design   | 0.886 |
 *
 *
 *   The SIC rule rejected both false matches and accepted 6 of 8 real carriers. It also rejected Bandwidth
 *   (SIC 7372) and Ooma (7374); widening the range would admit WidePoint (7373). Keep the allowlist narrow
 *   and record exceptions as named `pinnedCIKs`. A rejection means uncorroborated, not disproven.
 */

import type { CIK } from "#sdk/edgar/filings/index"

/**
 * Enumerated SIC codes accepted as telecom corroboration.
 */
export const TELECOM_SIC_CODES: ReadonlySet<string> = new Set([
	"4812", // Radiotelephone communications.
	"4813", // Telephone communications (no radiotelephone) — the ILECs and most CLECs.
	"4822", // Telegraph and other message communications.
	"4832", // Radio broadcasting stations.
	"4833", // Television broadcasting stations.
	"4841", // Cable and other pay television services.
	"4899", // Communications services, NEC — where satellite and in-flight providers land.
])

/**
 * Reason a candidate was or was not corroborated.
 */
export const CIKCorroborationBasis = {
	/**
	 * Registrant SIC is in the accepted set.
	 */
	TelecomSIC: "telecom-sic",
	/**
	 * Operator explicitly pinned this CIK; SIC was not checked.
	 */
	Pinned: "pinned",
	/**
	 * SIC is present but outside the accepted set.
	 */
	NonTelecomSIC: "non-telecom-sic",
	/**
	 * EDGAR supplied no SIC to evaluate.
	 */
	NoSIC: "no-sic",
} as const

export type CIKCorroborationBasis = (typeof CIKCorroborationBasis)[keyof typeof CIKCorroborationBasis]

export interface CIKCorroborationVerdict {
	corroborated: boolean
	basis: CIKCorroborationBasis
	/**
	 * SIC evaluated, when available.
	 */
	sic?: string
}

export interface CIKCorroborationOptions {
	/**
	 * Specific CIK exceptions checked before SIC; record a reason for each pin.
	 */
	pinnedCIKs?: ReadonlySet<string>
	/**
	 * Accepted SIC codes; defaults to {@linkcode TELECOM_SIC_CODES}.
	 */
	acceptedSICCodes?: ReadonlySet<string>
}

/**
 * Corroborate a name-matched CIK using its SIC or an explicit pin; this function never uses the name score.
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
