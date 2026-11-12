// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Checks that every tracked first-party source file starts with the SPDX header.
 *
 * Oxlint's `mailwoman/spdx-header` rule covers JavaScript and TypeScript, using the parser's comment ranges.
 * This check covers the tracked files oxlint never reads: Rust, Java, C++, CSS and shell.
 * Both decide through `@mailwoman/core/spdx-header`.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isScriptSourcePath, sourceHeaderProblem, sourceHeaderSyntax } from "@mailwoman/core/spdx-header"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#repo-health/check"

/**
 * The command that rewrites every failing file.
 */
const FIX_COMMAND = "node packages/mailwoman/tools/dev-tools/spdx-header.run.ts"

/**
 * The `spdx-header` check.
 *
 * It reports one error for each tracked source file whose first lines aren't
 * the SPDX header and a blank line.
 */
export const spdxHeaderCheck: RepoCheck = {
	id: "spdx-header",
	description: "Every first-party source file starts with the SPDX header.",
	async run(context) {
		const diagnostics: Diagnostic[] = []

		for (const path of context.trackedFiles) {
			const syntax = sourceHeaderSyntax(path)

			// Oxlint's rule reads these with the parser's comment ranges.
			// This check has no parser.
			if (syntax == null || isScriptSourcePath(path)) continue

			const text = await readLocalTextFile(resolvePath(context.repoRoot, path))
			const problem = sourceHeaderProblem(text, syntax)

			if (problem == null) continue

			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				message: `${problem} Run \`${FIX_COMMAND}\` to rewrite every failing file.`,
				file: path,
				line: 1,
				details: null,
			})
		}

		return diagnostics
	},
}
