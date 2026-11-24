// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `layout-citations` check: every rendered address layout cites a primary document,
 *   except the jurisdictions `lib/repo-health/uncited-address-layouts.json` lists.
 *
 *   A primary document is the postal operator's own rules, UPU's Postal Addressing
 *   Systems description, or the country's S42 template, recorded with its URL, date,
 *   sha256 and the example lines the layout rests on. libaddressinput's `fmt` is the
 *   dataset most generated layouts came from, and it isn't a citation.
 *
 *   The list holds one code per line with the search that found no document, so two changes
 *   that cite different jurisdictions delete different lines and merge without a conflict.
 *   A committed count would conflict on every such pair.
 */

import { uncitedLayoutJurisdictions } from "@mailwoman/codex/address/layouts"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

const ALLOWED_FILE = "lib/repo-health/uncited-address-layouts.json"

/**
 * Fails on an uncited layout the list doesn't allow, and on a listed code that's now cited.
 */
export const layoutCitationsCheck: RepoCheck = {
	id: "layout-citations",
	description:
		"Every rendered address layout cites a primary document: the postal operator's rules, its UPU description or its S42 template. libaddressinput is a dataset, not a citation.",
	async run(context) {
		const allowed = (
			await readLocalJSONFile<{ uncited: Record<string, string> }>(resolvePath(context.repoRoot, ALLOWED_FILE))
		).uncited

		const uncited = new Set(uncitedLayoutJurisdictions())
		const diagnostics: Diagnostic[] = []
		const unlisted = [...uncited].filter((code) => !(code in allowed))
		const nowCited = Object.keys(allowed).filter((code) => !uncited.has(code))

		if (unlisted.length) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file: "packages/codex/lib/address/layouts/citations.ts",
				line: null,
				message: `${unlisted.length} jurisdictions render an address layout that cites no primary document. Read the operator's document and add a citation to the range module for the code's letter under layouts/citations/.`,
				details: [unlisted.join(" ")],
			})
		}

		if (nowCited.length) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file: ALLOWED_FILE,
				line: null,
				message: `${nowCited.length} listed jurisdictions now cite a primary document. Delete their lines from the list.`,
				details: [nowCited.join(" ")],
			})
		}

		return diagnostics
	},
}
