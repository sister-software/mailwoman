/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Golden eval-set validator (Phase 1 task #9 in the plan).
 *
 *   The golden set is hand-labeled ground truth for the neural classifier. Each entry must carry
 *   components whose surface forms actually occur in `raw` — otherwise the entry will silently rot
 *   the eval signal. This module:
 *
 *   - Defines `GoldenEntry` (schema check).
 *   - Loads `.jsonl` files (one entry per line).
 *   - Validates every entry: schema shape, ComponentTag membership, reachability of each component in
 *       `raw` via the same `reconcileComponents` helper alignment uses.
 *   - Returns a structured report of per-entry errors so the CLI / CI surface can act on it.
 *
 *   The 1000-entry target (500 US + 500 FR) is a human task. This module catches the regressions that
 *   creep in over time as new entries land.
 */

import { readdir, readFile } from "node:fs/promises"
import { extname, join } from "node:path"

import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"

import { reconcileComponents } from "./format.js"

const TAG_SET = new Set<string>(COMPONENT_TAGS as readonly string[])

/** One entry in a golden `.jsonl` file. */
export interface GoldenEntry {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	country: string
	source: "golden"
	notes?: string
}

/** Per-entry validation failure. */
export interface GoldenIssue {
	file: string
	line: number
	reason: string
}

/** Aggregate report from `validateGoldenDir`. */
export interface GoldenReport {
	entries: number
	files: number
	issues: GoldenIssue[]
}

/** Parse a single JSONL line into a `GoldenEntry`. Throws on schema violations. */
export function parseGoldenLine(line: string): GoldenEntry {
	const obj = JSON.parse(line) as Partial<GoldenEntry> & Record<string, unknown>

	if (typeof obj.raw !== "string" || obj.raw.length === 0) {
		throw new Error("missing/empty raw")
	}

	if (typeof obj.country !== "string" || !/^[A-Z]{2}$/u.test(obj.country)) {
		throw new Error(`country must be ISO 3166-1 alpha-2 (got ${JSON.stringify(obj.country)})`)
	}

	if (obj.source !== "golden") {
		throw new Error(`source must be "golden" (got ${JSON.stringify(obj.source)})`)
	}
	const components = (obj.components ?? {}) as Record<string, unknown>

	for (const [k, v] of Object.entries(components)) {
		if (!TAG_SET.has(k)) throw new Error(`unknown ComponentTag: ${k}`)

		if (typeof v !== "string" || v.length === 0) {
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

/** Check that every component in `entry` appears in `entry.raw` (reconciliation-equivalent). */
export function unreachableComponents(entry: GoldenEntry): ComponentTag[] {
	const reconciled = reconcileComponents(entry.components, entry.raw)
	const missing: ComponentTag[] = []

	for (const tag of Object.keys(entry.components) as ComponentTag[]) {
		if (!(tag in reconciled)) {
			missing.push(tag)
		}
	}

	return missing
}

/** Validate one `.jsonl` file end-to-end, returning a list of issues. */
export async function validateGoldenFile(path: string): Promise<GoldenIssue[]> {
	const text = await readFile(path, "utf8")
	const lines = text.split("\n")
	const issues: GoldenIssue[] = []

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim()

		if (!line) continue

		try {
			const entry = parseGoldenLine(line)
			const unreachable = unreachableComponents(entry)

			if (unreachable.length > 0) {
				issues.push({
					file: path,
					line: i + 1,
					reason: `components not reachable in raw: ${unreachable.join(", ")}`,
				})
			}
		} catch (err) {
			issues.push({ file: path, line: i + 1, reason: (err as Error).message })
		}
	}

	return issues
}

/** Validate every `.jsonl` in a golden directory. */
export async function validateGoldenDir(dir: string): Promise<GoldenReport> {
	const files = (await readdir(dir)).filter((n) => extname(n) === ".jsonl").sort()
	const issues: GoldenIssue[] = []
	let entries = 0

	for (const name of files) {
		const fullPath = join(dir, name)
		const fileIssues = await validateGoldenFile(fullPath)
		issues.push(...fileIssues)
		const text = await readFile(fullPath, "utf8")
		entries += text.split("\n").filter((l) => l.trim()).length
	}

	return { entries, files: files.length, issues }
}
