/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Projects Python docstrings as line comments for the focused Vale pass.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { runFile } from "@mailwoman/core/process"
import type { PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"

interface PythonDocstring {
	startLine: number
	endLine: number
	contentStartLine: number
	content: string
}

type PythonDocstringReport = Record<string, PythonDocstring[]>

/**
 * Writes one comment-only Python projection per source file that has docstrings.
 *
 * Each projected line stays at its source line so Vale can report the original location.
 */
export async function writePythonDocstringProjections(
	pythonFiles: readonly string[],
	repoRoot: PathBuilder,
	temporaryRoot: PathBuilder
): Promise<{ files: string[]; displayPathPrefix: string }> {
	if (!pythonFiles.length) return { files: [], displayPathPrefix: temporaryRoot.toString() }

	const helper = repoRoot("corpus-python", "scripts", "comment_nodes.py").toString()
	const absoluteFiles = pythonFiles.map((file) => repoRoot(...file.split("/")).toString())

	const { stdout } = await runFile("python3", [helper, "--docstrings", ...absoluteFiles], {
		cwd: repoRoot.toString(),
	})

	const report = parseJSONStrict<PythonDocstringReport>(stdout)
	const paths: string[] = []

	for (const [absolutePath, docstrings] of Object.entries(report)) {
		if (!docstrings.length) continue

		const relativePath = absolutePath.replace(`${repoRoot.toString()}/`, "")
		const projectedPath = temporaryRoot(relativePath)
		const lastLine = Math.max(...docstrings.map(({ endLine }) => endLine))
		const lines = Array.from({ length: lastLine }).map(() => "")

		for (const { content, contentStartLine } of docstrings) {
			let offset = 0

			for (const line of TextSpliterator.from(content, { skipEmpty: false })) {
				const index = contentStartLine - 1 + offset
				lines[index] = line.trim() ? `# ${line}` : "#"
				offset += 1
			}
		}

		await writeLocalTextFile(`${lines.join("\n")}\n`, projectedPath)
		paths.push(projectedPath.toString())
	}

	return { files: paths, displayPathPrefix: temporaryRoot.toString() }
}
