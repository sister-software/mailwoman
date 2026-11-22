// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The session's refusal of a layer whose recorded license imposes a refused obligation class.
 *
 *   The refusal classes and their decision against an expression are `@mailwoman/license/refusals`.
 */

import type { LayerManifest } from "@mailwoman/core/layers"
import { obligationFindings, type ObligationRefusal } from "@mailwoman/license/refusals"

/**
 * Throws when a layer's recorded license includes a refused obligation class.
 *
 * The message repeats the layer's provenance as its manifest records it: name,
 * license, credit, source, input URL and digest.
 * A refused layer therefore reports what it is and where it came from, and the operator
 * can remove it or change the refusal knowing which data is in question.
 *
 * @throws When `obligationFindings` finds a refused class in the manifest's license.
 */
export function assertLayerObligationsAccepted(
	manifest: LayerManifest,
	path: string,
	refuse: readonly ObligationRefusal[]
): void {
	const findings = obligationFindings(manifest.license, refuse)

	if (!findings.length) return

	const provenance = [
		`layer ${manifest.name} at ${path}`,
		`license ${manifest.license}`,
		`credit ${manifest.attribution ?? "unrecorded"}`,
		`source ${manifest.source} (${manifest.sourceVintage})`,
		`input ${manifest.sourceURL ?? "unrecorded"} sha256 ${manifest.sourceSHA256 ?? "unrecorded"}`,
	]

	throw new Error(
		`MAILWOMAN_REFUSE_OBLIGATIONS refuses ${findings.map((finding) => finding.reason).join("; ")}. ` +
			`The session will not attach ${provenance.join(", ")}. ` +
			"Remove the database, or drop the class from MAILWOMAN_REFUSE_OBLIGATIONS."
	)
}
