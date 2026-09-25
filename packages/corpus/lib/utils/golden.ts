/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Validates the hand-labeled golden eval set, where every labeled component must occur in `raw`.
 */

import { componentsPresentIn } from "@mailwoman/codex/address-format"
import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/codex/component"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"

const TAG_SET = new Set<string>(COMPONENT_TAGS as readonly string[])

/**
 * A golden-set candidate row, as `golden-expand` writes and `golden-promote` reads.
 *
 * `source` identifies the producer, such as `expand-golden:<provider>`.
 * The seed and provenance fields trace the candidate to its corpus row and LLM call.
 * {@link GoldenEntry} narrows this type to a committed entry.
 */
export interface GoldenCandidateEntry {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	country: string
	source: string
	notes?: string
	seed_source_id?: string
	seed_source_adapter?: string
	dropped_components?: string[]
	provenance?: { provider: string; model: string }
}

/**
 * One entry in a golden `.jsonl` file.
 */
export interface GoldenEntry extends GoldenCandidateEntry {
	source: "golden"
}

/**
 * A validation failure for one line of a golden file.
 */
export interface GoldenIssue {
	file: string
	line: number
	reason: string
}

/**
 * The aggregate report that `validateGoldenDir` returns.
 */
export interface GoldenReport {
	entries: number
	files: number
	issues: GoldenIssue[]
}

/**
 * Parses one JSONL line into a `GoldenEntry`.
 *
 * `validateGoldenFile` records the thrown message against the line number, so this parse must stay strict.
 *
 * @throws On schema violations.
 */
export function parseGoldenLine(line: string): GoldenEntry {
	const obj = parseJSONStrict<Partial<GoldenEntry> & Record<string, unknown>>(line)

	if (typeof obj.raw !== "string" || !obj.raw.length) {
		throw new Error("missing/empty raw")
	}

	if (typeof obj.country !== "string" || !/^[A-Z]{2}$/u.test(obj.country)) {
		throw new Error(`country must be ISO 3166-1 alpha-2 (got ${stringifyJSON(obj.country)})`)
	}

	if (obj.source !== "golden") {
		throw new Error(`source must be "golden" (got ${stringifyJSON(obj.source)})`)
	}

	const components = (obj.components ?? {}) as Record<string, unknown>

	for (const [k, v] of Object.entries(components)) {
		if (!TAG_SET.has(k)) throw new Error(`unknown ComponentTag: ${k}`)

		if (typeof v !== "string" || !v.length) {
			throw new Error(`components.${k} must be a non-empty string`)
		}
	}

	return {
		raw: obj.raw,
		components: components as GoldenEntry["components"],
		country: obj.country,
		source: "golden",
		notes: typeof obj.notes === "string" ? obj.notes : undefined,
	}
}

/**
 * Returns the tags in `entry` whose values do not occur in `entry.raw`.
 *
 * A golden `raw` is hand-written, so this check uses containment instead of
 * reconciling against a rendered layout.
 */
export function unreachableComponents(entry: GoldenEntry): ComponentTag[] {
	const present = componentsPresentIn(entry.components, entry.raw)
	const missing: ComponentTag[] = []

	for (const tag of Object.keys(entry.components) as ComponentTag[]) {
		if (!(tag in present)) {
			missing.push(tag)
		}
	}

	return missing
}

/**
 * Validates one `.jsonl` file and returns its issues.
 *
 * This reads lines with `TextSpliterator` because `JSONSpliterator` throws on the first malformed row.
 * The validator must instead report every bad row with its line number.
 */
export async function validateGoldenFile(source: PathBuilderLike): Promise<GoldenIssue[]> {
	const path = source.toString()
	const issues: GoldenIssue[] = []
	// Blank lines count too, so the number matches the line an editor shows.
	let lineNumber = 0

	for await (const raw of TextSpliterator.fromAsync(path, { skipEmpty: false })) {
		lineNumber++
		const line = raw.trim()

		if (!line) continue
		const i = lineNumber - 1

		try {
			const entry = parseGoldenLine(line)
			const unreachable = unreachableComponents(entry)

			if (unreachable.length) {
				issues.push({
					file: path,
					line: i + 1,
					reason: `components not reachable in raw: ${unreachable.join(", ")}`,
				})
			}
		} catch (error) {
			issues.push({ file: path, line: i + 1, reason: (error as Error).message })
		}
	}

	return issues
}

/**
 * Validates every `.jsonl` file directly inside a golden directory.
 */
export async function validateGoldenDir(dir: PathBuilderLike): Promise<GoldenReport> {
	const root = PathBuilder.from(dir)
	const files = await Globerator.files("jsonl", { cwd: root, absolute: false, recursive: false }).toSorted()
	const issues: GoldenIssue[] = []
	let entries = 0

	for (const name of files) {
		const fullPath = root(name)
		const fileIssues = await validateGoldenFile(fullPath)
		issues.push(...fileIssues)

		for await (const line of TextSpliterator.fromAsync(fullPath)) {
			if (line.trim()) {
				entries++
			}
		}
	}

	return { entries, files: files.length, issues }
}
