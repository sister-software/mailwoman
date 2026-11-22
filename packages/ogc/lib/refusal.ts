// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Whether the operator's refused obligation classes keep a layer from being served in bulk.
 *
 *   The items routes page through a whole gazetteer, so `MAILWOMAN_REFUSE_OBLIGATIONS`
 *   applies to them as it applies to attaching an OpenStreetMap layer.
 */

import { obligationFindings, ObligationRefusal } from "@mailwoman/license/refusals"

/**
 * Why the refused classes keep a layer with this recorded license from serving items,
 * or null when none applies.
 *
 * A refused class among the license's obligations refuses it.
 * A license the manifest doesn't record has unknown obligations, so `unresolved` refuses it too.
 *
 * @param license The SPDX expression the layer's manifest records, or null when it records none.
 */
export function itemsRefusal(license: string | null, refuse: readonly ObligationRefusal[]): string | null {
	if (!license) {
		return refuse.includes(ObligationRefusal.Unresolved)
			? "MAILWOMAN_REFUSE_OBLIGATIONS refuses unresolved obligations, and the database records no license"
			: null
	}

	const findings = obligationFindings(license, refuse)

	return findings.length
		? `MAILWOMAN_REFUSE_OBLIGATIONS refuses ${findings.map(({ reason }) => reason).join("; ")}`
		: null
}
