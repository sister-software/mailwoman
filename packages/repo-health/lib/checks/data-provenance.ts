/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Every committed data artifact in a `data/` directory is named by that directory's `PROVENANCE.md`.
 *
 *   A `data/` directory holds artifacts a build wrote and a human is expected to leave alone. Nothing in the file says
 *   so — a JSON file looks the same whether a generator produced it or somebody typed it — and the prose linter reads
 *   `.ts`, `.tsx`, `.py`, `.yaml`, `.yml`, `.md` and `.mdx`, so no automated pass inspects these at all. What actually
 *   happened is that a hand sweep rewrote `Contracts Finder / Find a Tender` to `Interfaces Finder / Find a Tender`
 *   inside a generated register, and the register's own structural audit passed (#2352).
 *
 *   `PROVENANCE.md` is where a directory records, per artifact, what wrote it and how a reader checks it. The check is
 *   that the record exists and covers every artifact, so an artifact landing without one is a deliberate act rather
 *   than an oversight. It does not verify the artifact's contents: `address-source-register.json` does that itself
 *   with a `contentDigest` its reader recomputes.
 *
 *   Coverage is two questions, because an artifact can be out of reach in two ways. Every artifact file directly in
 *   the directory has to be named, and so does every immediate subdirectory. The second was added after
 *   `packages/core/data/coarse-placer/` was found shipping a trained classifier in every copy of `@mailwoman/core`
 *   with no record anywhere: each of core's four data directories is one level down, so a file-only rule reports
 *   nothing about any of them.
 *
 *   A subdirectory is named rather than recursed into. Requiring every file at any depth would ask
 *   `packages/core/data/PROVENANCE.md` to list 1,114 vendored dictionary files, which is a list nobody reads and
 *   nobody keeps true. Naming the directory is the claim a reader checks, and a subdirectory with its own
 *   `PROVENANCE.md` is covered by this check in its own right.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { basename, dirname, resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * Extensions a `data/` directory holds that this check reads as an artifact.
 *
 * A README, a `PROVENANCE.md` and a license file are prose about the directory rather than data in it.
 * Everything else committed there is something a consumer loads.
 */
const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([".json", ".jsonl", ".csv", ".tsv", ".bin", ".txt"])

/**
 * Files in a `data/` directory that document it rather than live in it.
 */
const DOCUMENTATION_FILES: ReadonlySet<string> = new Set(["PROVENANCE.md", "README.md", "LICENSE.md", "LICENSE"])

/**
 * The names of the directories committed directly inside `directory`, in the order git lists them.
 *
 * Derived from the tracked-file list rather than by walking the filesystem, so an untracked
 * scratch directory a build left behind is not reported as an undocumented one.
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
 * Reads every package's `data` directory that carries a `PROVENANCE.md`
 * and reports each artifact the file does not name.
 *
 * Scoped to directories that already have one.
 * A `data/` directory with no `PROVENANCE.md` is a different claim.
 *
 * That the directory should have one at all — and making this check assert it would turn a
 * documentation gap in unrelated packages into a failing build on the commit that adds this file.
 *
 * Registered in `#registry`, so `mwops health data-provenance` runs it.
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
