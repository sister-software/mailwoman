/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every committed data artifact in a `data/` directory is named by that directory's `PROVENANCE.md`.
 *
 *   A `data/` directory holds artifacts a build wrote and a human is expected to leave alone, and no automated
 *   pass inspects them: a JSON file looks the same whether a generator produced it or somebody typed it.
 *
 *   `PROVENANCE.md` records per artifact what wrote it and how a reader checks it; the check requires the record to
 *   name every artifact, and does not verify the artifact's contents.
 *
 *   Coverage names every artifact file directly in the directory and every immediate subdirectory, because each of
 *   core's four data directories is one level down and a file-only rule reports no finding about any of them.
 *
 *   A subdirectory is named rather than recursed into: requiring every file at any depth would ask
 *   `packages/core/data/PROVENANCE.md` to list 1,114 vendored dictionary files, a list nobody reads or keeps true.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { basename, dirname, resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".jsonl", ".csv", ".tsv", ".bin", ".txt"])

const DOCUMENTATION_FILES: ReadonlySet<string> = new Set(["PROVENANCE.md", "README.md", "LICENSE.md", "LICENSE"])

/**
 * The names of the directories committed directly inside `directory`, derived from the tracked-file
 * list so an untracked scratch directory a build left behind is not reported as undocumented.
 */
function immediateSubdirectories(trackedFiles: readonly string[], directory: string): string[] {
	const prefix = `${directory}/`
	const names = new Set<string>()

	for (const file of trackedFiles) {
		if (!file.startsWith(prefix)) continue

		const rest = file.slice(prefix.length)
		const separator = rest.indexOf("/")

		if (separator > 0) {
			names.add(rest.slice(0, separator))
		}
	}

	return [...names]
}

/**
 * Reads every package's `data` directory that already carries a `PROVENANCE.md`
 * and reports each artifact the file does not name.
 */
export const dataProvenanceCheck: RepoCheck = {
	id: "data-provenance",
	description: "Every committed artifact in a `data/` directory is named by that directory's PROVENANCE.md",

	async run({ repoRoot, trackedFiles }): Promise<Diagnostic[]> {
		const diagnostics: Diagnostic[] = []

		const provenanceFiles = trackedFiles.filter((file) => /^packages\/[^/]+\/data\/PROVENANCE\.md$/u.test(file))

		for (const provenanceFile of provenanceFiles) {
			const directory = dirname(provenanceFile)
			const recorded = await readLocalTextFile(resolvePath(repoRoot, provenanceFile))

			const artifacts = trackedFiles.filter((file) => {
				if (dirname(file) !== directory) return false

				const name = basename(file)

				if (DOCUMENTATION_FILES.has(name)) return false

				return ARTIFACT_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))
			})

			for (const artifact of artifacts) {
				const name = basename(artifact)

				if (recorded.includes(name)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`\`${name}\` is committed in \`${directory}\` and \`${provenanceFile}\` does not name it. ` +
						"Record what writes it and how a reader checks it, so the next person to open the file knows " +
						"whether editing it by hand is a repair or a corruption.",
					file: provenanceFile,
				})
			}

			for (const child of immediateSubdirectories(trackedFiles, directory)) {
				if (recorded.includes(child)) continue

				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					message:
						`\`${child}/\` is committed in \`${directory}\` and \`${provenanceFile}\` does not name it. ` +
						"Say what the directory holds and what wrote it. Naming it is enough — this check does not ask " +
						"for the files inside, and a subdirectory with its own `PROVENANCE.md` is checked separately.",
					file: provenanceFile,
				})
			}
		}

		return diagnostics
	},
}
