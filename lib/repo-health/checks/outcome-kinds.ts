// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { sha256Hex } from "@mailwoman/core/crypto/hash"
import { wofReposPath } from "@mailwoman/core/data-root"
import { gitSync } from "@mailwoman/core/repo/git"
import { canonicalJSON, parseJSONStrict } from "@mailwoman/core/values/json"
import { OUTCOME_KINDS_MODULE, outcomeKindRows } from "@mailwoman/gazetteer/tools/outcomes/render"
import { resolveWOFRepo } from "@mailwoman/gazetteer/whosonfirst/extract-repo"
import { OUTCOMES_REPO, OUTCOMES_SPEC_FILE } from "@mailwoman/gazetteer/whosonfirst/outcomes/definition"
import { OUTCOME_DEFINITIONS_PIN, OUTCOME_KINDS } from "@mailwoman/gazetteer/whosonfirst/outcomes/kinds"
import type { CompiledOutcomeSpec } from "@mailwoman/gazetteer/whosonfirst/outcomes/spec"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

function error(message: string): Diagnostic {
	return { severity: DiagnosticSeverity.Error, message, file: OUTCOME_KINDS_MODULE, line: null, details: null }
}

/**
 * Checks that `@mailwoman/gazetteer/whosonfirst/outcomes/kinds` is the compiled
 * spec of the definitions clone at its pinned revision.
 */
export const outcomeKindsCheck: RepoCheck = {
	id: "outcome-kinds",
	description:
		"The generated OUTCOME_KINDS table equals the whosonfirst-outcomes compiled spec at the pinned revision, and that spec hashes to the pinned sha256.",
	async run() {
		const repo = await resolveWOFRepo(wofReposPath(), OUTCOMES_REPO.name)

		// A host without the clone, such as a GitHub-hosted runner, can't read the pinned spec.
		if (!repo) {
			return [
				{
					...error(
						`The outcome kinds are unverified on this host: ${OUTCOMES_REPO.name} isn't cloned under ${wofReposPath().toString()}.`
					),
					severity: DiagnosticSeverity.Warning,
				},
			]
		}

		let text: string

		try {
			text = gitSync(["show", `${OUTCOME_DEFINITIONS_PIN.revision}:${OUTCOMES_SPEC_FILE}`], { cwd: repo, trim: false })
		} catch {
			return [
				error(
					`${repo} has no ${OUTCOMES_SPEC_FILE} at the pinned revision ${OUTCOME_DEFINITIONS_PIN.revision}; fetch the clone.`
				),
			]
		}

		const sha256 = sha256Hex(text)

		if (sha256 !== OUTCOME_DEFINITIONS_PIN.sha256) {
			return [
				error(
					`The spec at ${OUTCOME_DEFINITIONS_PIN.revision} hashes to ${sha256}, and the module pins ${OUTCOME_DEFINITIONS_PIN.sha256}.`
				),
			]
		}

		const expected = Object.fromEntries(outcomeKindRows(parseJSONStrict<CompiledOutcomeSpec>(text)))

		if (canonicalJSON(expected) !== canonicalJSON(OUTCOME_KINDS)) {
			return [
				error("OUTCOME_KINDS differs from the pinned spec; run node packages/gazetteer/tools/outcomes/compile.run.ts."),
			]
		}

		return []
	},
}
