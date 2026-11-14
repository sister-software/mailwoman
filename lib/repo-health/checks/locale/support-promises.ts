// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `support-promises` check: every support promise in `@mailwoman/codex/support`
 *   is stated in registered codes and has a passing gauntlet case behind it.
 *
 *   A promise's evidence is every gauntlet case in its country whose letters are
 *   all written in the promise's input script.
 *   A promise without a passing case would tell customers something no check can
 *   show to be false, so the check refuses it.
 *
 *   A failing case inside a promise is a bug the promise makes visible,
 *   so the check reports each one as a warning against that promise.
 */

import { type SupportPromise, SUPPORT_DEPTHS, SUPPORT_PROMISES } from "@mailwoman/codex/support"
import { impliedScript, parseLanguageTag } from "@mailwoman/registry/bcp47/tag"
import { parseCountryCodeAlpha2 } from "@mailwoman/registry/iso3166/alpha2"
import { isWrittenInScript, parseScriptCode } from "@mailwoman/registry/iso15924/codes"
import type { BCP47 } from "@mailwoman/registry/types"
import { loadRegressionCases } from "mailwoman/tools/eval-harness/gauntlet/cases/load"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

const DECLARATION = "packages/codex/lib/support/promises.json"

/**
 * The number of failing case ids a warning lists before it reports the rest as a count.
 */
const LISTED_FAILURES = 5

function label(promise: SupportPromise): string {
	return `${promise.country} × ${promise.input}`
}

/**
 * The script a promise's input tag fixes, or the reason the tag can't fix one.
 */
function promiseScript(promise: SupportPromise): { script: BCP47.ScriptCode } | { problem: string } {
	const parsed = parseLanguageTag(promise.input)

	if (!parsed.ok) {
		return {
			problem: `input ${promise.input} is refused by the registry (${parsed.reason}${parsed.part ? `: ${parsed.part}` : ""})`,
		}
	}

	if (parsed.value.tag !== promise.input) {
		return { problem: `input ${promise.input} isn't canonical; write ${parsed.value.tag}` }
	}

	const script = parsed.value.script ? impliedScript(parsed.value) : null

	if (!script) return { problem: `input ${promise.input} has no script subtag; a promise states the script it covers` }

	return { script }
}

/**
 * Checks each support promise's codes and evidence.
 */
export const supportPromisesCheck: RepoCheck = {
	id: "support-promises",
	description:
		"Every support promise is stated in registered codes and has a passing gauntlet case in its country and input script.",
	async run() {
		const diagnostics: Diagnostic[] = []
		const cases = await loadRegressionCases()
		const seen = new Set<string>()

		const error = (message: string): void => {
			diagnostics.push({ severity: DiagnosticSeverity.Error, message, file: DECLARATION, line: null, details: null })
		}

		for (const promise of SUPPORT_PROMISES) {
			const key = label(promise)

			if (seen.has(key)) {
				error(`${key} is declared twice`)
			}

			seen.add(key)

			const country = parseCountryCodeAlpha2(promise.country)

			if (!country.ok) {
				error(`${key}: country ${promise.country} is refused by the registry (${country.reason})`)
			}

			for (const embedded of promise.embeddedNameScripts) {
				const parsed = parseScriptCode(embedded)

				if (!parsed.ok) {
					error(`${key}: embedded name script ${embedded} is refused by the registry (${parsed.reason})`)
				}
			}

			if (!(SUPPORT_DEPTHS as readonly string[]).includes(promise.depth)) {
				error(`${key}: depth ${promise.depth} is none of ${SUPPORT_DEPTHS.join(", ")}`)
			}

			const resolved = promiseScript(promise)

			if ("problem" in resolved) {
				error(`${key}: ${resolved.problem}`)

				continue
			}

			const evidence = cases.filter(
				(row) => row.country.toUpperCase() === promise.country && isWrittenInScript(row.input, resolved.script)
			)

			const passing = evidence.filter((row) => row.status === "pass")
			const failing = evidence.filter((row) => row.status !== "pass")

			if (!passing.length) {
				error(
					`${key}: no passing gauntlet case is in ${promise.country} and written in ${resolved.script} ` +
						`(${evidence.length} cases match, ${failing.length} of them failing); add one under ` +
						`packages/mailwoman/tools/eval-harness/gauntlet/cases/${promise.country.toLowerCase()}/ or withdraw the promise`
				)
			}

			if (failing.length) {
				const listed = failing.slice(0, LISTED_FAILURES).map((row) => `${row.id} (${row.status})`)
				const rest = failing.length > LISTED_FAILURES ? ` and ${failing.length - LISTED_FAILURES} more` : ""

				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					message: `${key}: ${failing.length} of ${evidence.length} gauntlet cases inside the promise fail, each an open bug against it: ${listed.join(", ")}${rest}`,
					file: DECLARATION,
					line: null,
					details: null,
				})
			}
		}

		return diagnostics
	},
}
