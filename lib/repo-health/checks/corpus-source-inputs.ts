/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every corpus source the checkout can emit is mapped to the register sources its rows are built from.
 *
 *   The corpus build and training launch refuse an unmapped source when they run. That check can happen hours after the
 *   change that added it. This check reports the same omission at lint time: each adapter id, each Python builder's
 *   `SOURCE` constant and each spelling in `RECIPE_SOURCES` and `CARRIED_SOURCES` must resolve to an entry in
 *   `packages/corpus/data/corpus-source-inputs.json`, whose own reader checks each entry against the register.
 */

import { readAddressSourceRegister } from "@mailwoman/corpus/source-register"
import { readCorpusSourceInputs } from "@mailwoman/corpus/source-register/corpus-inputs"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { declaredSourceNames } from "#repo-health/checks/wire-identifiers"

const TABLE = "packages/corpus/data/corpus-source-inputs.json"

/**
 * The `corpus-source-inputs` check: one error per declared source the table does not map.
 */
export const corpusSourceInputsCheck: RepoCheck = {
	id: "corpus-source-inputs",
	description:
		"Every corpus source an adapter, recipe, carried overlay or Python builder emits maps to the register sources its rows are built from.",
	async run(context) {
		const inputs = await readCorpusSourceInputs(await readAddressSourceRegister())
		const diagnostics: Diagnostic[] = []

		for (const source of [...(await declaredSourceNames(context))].toSorted()) {
			if (inputs.resolve(source)) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file: TABLE,
				line: 1,
				message:
					`corpus source \`${source}\` has no entry, so a build cannot tell which register sources its rows read. ` +
					"Add it with every publication whose text reaches a row, and add a register row in " +
					"source-additions.json for a publication the register does not carry.",
				details: null,
			})
		}

		return diagnostics
	},
}
