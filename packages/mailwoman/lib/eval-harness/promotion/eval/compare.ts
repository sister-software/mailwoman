/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Compare two `mailwoman eval promote` output directories before accepting a performance change.
 *   Every file is part of the receipt. Some fields record receipt location or elapsed wall time rather than a property
 *   of the evaluated artifact: `verdict.json.generated_at_dir`, the first `provenance.txt` line (`graded at ...`), and
 *   arena narration's paths under its own output directory and elapsed-time progress messages.
 */

import { readDirectoryEntries, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { join, type PathBuilderLike } from "path-ts"

type JSONValue = boolean | null | number | string | JSONValue[] | { [key: string]: JSONValue }

export interface PromotionOutputDifference {
	/**
	 * File-relative path, followed by a JSON path when the file is JSON.
	 */
	path: string
	baseline: string
	candidate: string
}

export interface PromotionOutputComparison {
	equal: boolean
	differences: PromotionOutputDifference[]
}

function describe(value: JSONValue | undefined): string {
	return value === undefined ? "<missing>" : JSON.stringify(value)
}

function normalizeProvenance(text: string): string {
	return text.replace(/^graded at .*(?:\r?\n|$)/, "")
}

function normalizeArenaNarration(text: string, directory: PathBuilderLike): string {
	return text
		.replaceAll(directory.toString(), "<promotion-output>")
		.replaceAll(/(\d+)\/(\d+) \(\d+(?:\.\d+)?s\)/g, "$1/$2 (<elapsed>)")
		.replaceAll(/Done in \d+(?:\.\d+)?s/g, "Done in <elapsed>")
}

function compareJSON(
	baseline: JSONValue | undefined,
	candidate: JSONValue | undefined,
	path: string,
	differences: PromotionOutputDifference[]
): void {
	if (typeof baseline !== "object" || baseline === null || typeof candidate !== "object" || candidate === null) {
		if (baseline !== candidate) {
			differences.push({ path, baseline: describe(baseline), candidate: describe(candidate) })
		}

		return
	}

	if (Array.isArray(baseline) || Array.isArray(candidate)) {
		if (!Array.isArray(baseline) || !Array.isArray(candidate)) {
			differences.push({ path, baseline: describe(baseline), candidate: describe(candidate) })

			return
		}

		const length = Math.max(baseline.length, candidate.length)

		for (let index = 0; index < length; index++) {
			compareJSON(baseline[index], candidate[index], `${path}[${index}]`, differences)
		}

		return
	}

	const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)])

	for (const key of [...keys].toSorted()) {
		compareJSON(baseline[key], candidate[key], `${path}.${key}`, differences)
	}
}

async function listFiles(directory: PathBuilderLike, prefix = ""): Promise<string[]> {
	const entries = await readDirectoryEntries(directory)
	const files: string[] = []

	for (const entry of entries) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

		if (entry.isDirectory()) {
			files.push(...(await listFiles(join(directory, entry.name), relativePath)))
		} else if (entry.isFile()) {
			files.push(relativePath)
		}
	}

	return files
}

/**
 * Compare every top-level promotion output. JSON files receive a field-level comparison so a changed score names its
 * field; Markdown and provenance files compare byte-for-byte.
 */
export async function comparePromotionOutputs(
	baselineDirectory: PathBuilderLike,
	candidateDirectory: PathBuilderLike
): Promise<PromotionOutputComparison> {
	const [baselineNames, candidateNames] = await Promise.all([
		listFiles(baselineDirectory),
		listFiles(candidateDirectory),
	])

	const differences: PromotionOutputDifference[] = []
	const names = new Set([...baselineNames, ...candidateNames])

	for (const name of [...names].toSorted()) {
		const baselinePath = join(baselineDirectory, name)
		const candidatePath = join(candidateDirectory, name)
		const presentInBaseline = baselineNames.includes(name)
		const presentInCandidate = candidateNames.includes(name)

		if (!presentInBaseline || !presentInCandidate) {
			differences.push({
				path: name,
				baseline: presentInBaseline ? "<present>" : "<missing>",
				candidate: presentInCandidate ? "<present>" : "<missing>",
			})

			continue
		}

		const [baseline, candidate] = await Promise.all([readLocalTextFile(baselinePath), readLocalTextFile(candidatePath)])

		if (!name.endsWith(".json")) {
			const isArenaNarration = name === "arenas.md" || (name.startsWith("arenas/") && name.endsWith(".stderr"))

			const normalizedBaseline =
				name === "provenance.txt"
					? normalizeProvenance(baseline)
					: isArenaNarration
						? normalizeArenaNarration(baseline, baselineDirectory)
						: baseline

			const normalizedCandidate =
				name === "provenance.txt"
					? normalizeProvenance(candidate)
					: isArenaNarration
						? normalizeArenaNarration(candidate, candidateDirectory)
						: candidate

			if (normalizedBaseline !== normalizedCandidate) {
				differences.push({ path: name, baseline: normalizedBaseline, candidate: normalizedCandidate })
			}

			continue
		}

		const baselineJSON = parseJSONStrict<JSONValue>(baseline)
		const candidateJSON = parseJSONStrict<JSONValue>(candidate)

		if (name === "verdict.json") {
			if (typeof baselineJSON === "object" && baselineJSON !== null && !Array.isArray(baselineJSON)) {
				delete baselineJSON.generated_at_dir
			}

			if (typeof candidateJSON === "object" && candidateJSON !== null && !Array.isArray(candidateJSON)) {
				delete candidateJSON.generated_at_dir
			}
		}

		compareJSON(baselineJSON, candidateJSON, name, differences)
	}

	return { equal: differences.length === 0, differences }
}
