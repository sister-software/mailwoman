/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman data inventory` — what is in the data root, and which of it can say how it was built.
 *
 *   Phase 1 of the lab-reproducibility sequence. `data status` answers "did the download arrive"; this
 *   answers the different question underneath it — "if this machine were gone, could the artifact be
 *   rebuilt from what it says about itself".
 *
 *   Output goes through {@linkcode writeRawStdout} rather than Ink for the reason `data/index.tsx` gives:
 *   an Ink frame at least as tall as the viewport emits `\x1b[2J\x1b[3J\x1b[H`, and `3J` wipes the
 *   scrollback. A full listing is 200+ lines, so on any terminal it would.
 */

import { mailwomanDataRoot, repoRootPath } from "@mailwoman/core/utils"
import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask, writeRawStdout } from "mailwoman/cli-kit"

import {
	buildCommandGaps,
	inventorySentence,
	type InventoryEntry,
	Provenance,
	rebuildHint,
	takeInventory,
} from "../../data-inventory.ts"
import { formatBytes } from "../../doctor/checks.ts"

export const description =
	"Report every database in the data root and whether it records how it was built. `layer_manifest` is " +
	"the contract (docs/engineering/reference/layer-contract.mdx); this says how much of the root implements it."

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "inventory",
	description,
	options: {
		"data-root": { type: "string", description: "Override the data root" },
		depth: { type: "string", description: "Directory levels to walk. Default 2" },
		all: { type: "boolean", default: false, description: "List every artifact, not just the summary" },
		json: { type: "boolean", default: false, description: "Emit the report as JSON" },
	},
} as const satisfies CommandSpec

interface Options {
	dataRoot?: string
	depth?: string
	all: boolean
	json: boolean
}

/**
 * One line per directory: how many of its databases carry a manifest, and how much disk they hold.
 *
 * The rollup is the actionable view and the flat list is not. The 2026-08-17 first run found 210 databases of which 53
 * were per-state address-point shards from ONE builder — so a per-artifact list reads as 53 problems where the rollup
 * reads as one, which is also how many code changes it takes to fix.
 */
function rollup(entries: readonly InventoryEntry[]): string[] {
	const by = new Map<string, { total: number; manifested: number; bytes: number }>()

	for (const entry of entries) {
		if (entry.provenance === Provenance.Foreign) continue

		const dir = entry.path.split("/")[0] ?? ""
		const current = by.get(dir) ?? { total: 0, manifested: 0, bytes: 0 }

		current.total++
		current.bytes += entry.bytes

		if (entry.provenance === Provenance.Manifested) {
			current.manifested++
		}

		by.set(dir, current)
	}

	return [...by]
		.toSorted((a, b) => b[1].bytes - a[1].bytes)
		.map(([dir, c]) => {
			const mark = c.manifested === c.total ? "✓" : c.manifested === 0 ? "✗" : "·"

			return `  ${mark} ${String(c.manifested).padStart(3)}/${String(c.total).padEnd(4)} ${formatBytes(c.bytes).padStart(10)}  ${dir}`
		})
}

const InventoryCommand: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const dataRoot = options.dataRoot ?? String(mailwomanDataRoot())

		const report = takeInventory({
			dataRoot,
			...(options.depth ? { maxDepth: Number(options.depth) } : {}),
		})

		if (options.json) {
			writeRawStdout(`${JSON.stringify(report, null, "\t")}\n`)

			return { ok: true }
		}

		const lines = [
			`mailwoman data inventory`,
			``,
			inventorySentence(report),
			``,
			`by directory:`,
			...rollup(report.entries),
		]

		// A manifest whose build command cannot be run documents nothing, and both ways of failing that were
		// found on the shipped artifacts: a path the workspace regroup moved, and a path under gitignored
		// `scratchpad/` that exists only on the machine that built it. Reported separately from the count,
		// because these artifacts PASS every "has a manifest" check.
		const repoRoot = String(repoRootPath())

		const broken = report.entries
			.filter((e) => e.provenance === Provenance.Manifested)
			.map((e) => ({ entry: e, gaps: buildCommandGaps(e.manifest!.build_cmd, repoRoot) }))
			.filter(({ gaps }) => gaps.length > 0)

		if (broken.length) {
			lines.push(
				``,
				`${broken.length} manifested artifact(s) record a build command that does not resolve in this repo:`,
				...broken.map(
					({ entry, gaps }) =>
						`  ✗ ${entry.path}\n      ${entry.manifest!.build_cmd}\n      missing: ${gaps.join(", ")}`
				)
			)
		}

		if (report.entries.some((e) => e.linkTarget)) {
			lines.push(``, `symlinked — the live choice, recorded nowhere else:`)

			for (const entry of report.entries.filter((e) => e.linkTarget)) {
				lines.push(`  ${entry.path} → ${entry.linkTarget}`)
			}
		}

		if (options.all) {
			lines.push(``, `every artifact:`)

			for (const entry of report.entries) {
				lines.push(`  ${entry.provenance.padEnd(14)} ${formatBytes(entry.bytes).padStart(10)}  ${entry.path}`)
				lines.push(`  ${" ".repeat(14)} ${" ".repeat(10)}  ↳ ${rebuildHint(entry)}`)
			}
		} else {
			lines.push(``, `Pass --all to list every artifact with the command that would rebuild it.`)
		}

		writeRawStdout(`${lines.join("\n")}\n`)

		return { ok: true }
	})

	if (state.status === "error") return <Text color="red">{state.message}</Text>

	return null
}

export default InventoryCommand
