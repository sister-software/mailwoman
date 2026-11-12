// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Reports an effects-register page that differs from what `yarn mwops effects-register` writes.
 */

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"
import { registerDrift, renderEffectsRegister } from "#repo-health/effects/register"

function diagnostic(file: string, message: string): Diagnostic {
	return { severity: DiagnosticSeverity.Error, message, file, line: null, details: null }
}

/**
 * The `effects-register` check.
 */
export const effectsRegisterCheck: RepoCheck = {
	id: "effects-register",
	description: "The committed effects-register pages equal the output of `yarn mwops effects-register`.",
	async run(context) {
		const { stale, extra } = await registerDrift(context.repoRoot, await renderEffectsRegister(context))

		return [
			...stale.map((file) =>
				diagnostic(
					file,
					`${file} differs from the generated register. Run \`yarn mwops effects-register\` and commit it.`
				)
			),
			...extra.map((file) =>
				diagnostic(
					file,
					`${file} is a register page for a group with no modules. Run \`yarn mwops effects-register\` to remove it.`
				)
			),
		]
	},
}
