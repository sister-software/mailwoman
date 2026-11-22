// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A layer build's admission policy over its sources: the sources it reads, the sources it excludes,
 *   and the sources it admits with unread terms.
 *
 *   The caller decides each source against its register and passes that decision in. This module
 *   applies the build's policy to the answers.
 */

/**
 * Why a source is left out of the layer.
 */
export const LayerExclusionReason = {
	/**
	 * A register row's decision is refused, or refuses one of the layer's operations.
	 */
	Refused: "refused",
	/**
	 * A register row's terms are unread.
	 *
	 * The decision is `unchecked`, or it states no permission for one of the layer's operations.
	 */
	Unread: "unread",
	/**
	 * The source maps to no register row, so the register records no publisher's terms for its rows.
	 */
	NoRegisterRow: "no-register-row",
} as const

/**
 * Why a source is left out of the layer: `refused`, `unread` or `no-register-row`.
 */
export type LayerExclusionReason = (typeof LayerExclusionReason)[keyof typeof LayerExclusionReason]

/**
 * One source the layer leaves out, with the register rows that decided it.
 */
export interface LayerSourceExclusion {
	/**
	 * The layer source id, such as `openaddresses:us/il/cook` or `overture:OpenAddresses/MI/Kent County`.
	 */
	source: string
	reason: LayerExclusionReason
	/**
	 * The register rows the source maps to, empty when the table maps it to none.
	 */
	registerSources: readonly string[]
	/**
	 * The first sentence of the deciding row's reason.
	 */
	because: string
}

/**
 * Decides, per layer source id, whether the layer may serve its rows.
 */
export type SourceAdmission = (source: string) => LayerSourceExclusion | null

/**
 * A build's admission policy over its sources, with the sources it has excluded
 * and those it admitted unread.
 */
export interface SourceAdmitter {
	/**
	 * Whether the build reads the source.
	 *
	 * Each source is decided and listed on its first call, and a later call returns the same answer.
	 */
	admits: (source: string) => boolean
	excluded: LayerSourceExclusion[]
	/**
	 * Sources admitted with unread terms or no register row, because the build doesn't exclude them.
	 */
	admittedUnread: LayerSourceExclusion[]
}

/**
 * Applies `admission` under a build's policy.
 *
 * A refused source is always excluded.
 * A source with unread terms or no register row is excluded when `excludeUnread` holds,
 * and admitted and listed in `admittedUnread` otherwise.
 */
export function createSourceAdmitter(admission: SourceAdmission, excludeUnread: boolean): SourceAdmitter {
	const excluded: LayerSourceExclusion[] = []
	const admittedUnread: LayerSourceExclusion[] = []
	const decided = new Map<string, boolean>()

	const admits = (source: string): boolean => {
		const known = decided.get(source)

		if (typeof known === "boolean") return known

		const exclusion = admission(source)
		const admitted = !exclusion || (exclusion.reason !== LayerExclusionReason.Refused && !excludeUnread)

		if (exclusion) {
			;(admitted ? admittedUnread : excluded).push(exclusion)
		}

		decided.set(source, admitted)

		return admitted
	}

	return { admits, excluded, admittedUnread }
}
