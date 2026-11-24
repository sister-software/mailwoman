// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `layout-citations` check: every jurisdiction whose rendered address
 *   layout cites no primary document.
 *
 *   A primary document is the postal operator's own rules, UPU's Postal Addressing
 *   Systems description, or the country's S42 template, recorded with its URL, date,
 *   sha256 and the example lines the layout rests on. libaddressinput's `fmt` is the
 *   dataset most generated layouts came from, and it isn't a citation.
 *
 *   The `debt` check pins the count as `uncitedAddressLayouts`, so a layout
 *   added without a citation fails there.
 *   This check lists each jurisdiction.
 */

import { uncitedLayoutJurisdictions } from "@mailwoman/codex/address/layouts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

/**
 * Lists the jurisdictions whose rendered layout lacks a primary citation.
 */
export const layoutCitationsCheck: RepoCheck = {
	id: "layout-citations",
	description:
		"Every rendered address layout cites a primary document: the postal operator's rules, its UPU description or its S42 template. libaddressinput is a dataset, not a citation.",
	async run() {
		const uncited = uncitedLayoutJurisdictions()

		if (!uncited.length) return []

		const diagnostics: Diagnostic[] = [
			{
				severity: DiagnosticSeverity.Warning,
				file: "packages/codex/lib/address/layouts/citations.ts",
				line: null,
				message: `${uncited.length} jurisdictions render an address layout that cites no primary document. Add a citation to LAYOUT_CITATIONS after reading the document.`,
				details: [uncited.join(" ")],
			},
		]

		return diagnostics
	},
}
