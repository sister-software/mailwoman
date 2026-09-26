/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Output goes through {@linkcode writeRawStdout} rather than Ink because an Ink frame at least as tall as the viewport
 *   emits `\x1b[2J\x1b[3J\x1b[H`, and `3J` wipes the scrollback.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { repoRootPathBuilder } from "@mailwoman/core/paths"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask, writeRawStdout } from "#cli-kit"
import {
	buildCommandGaps,
	inventorySentence,
	type InventoryEntry,
	Provenance,
	rebuildHint,
	takeInventory,
} from "#data/inventory"

export const description =
	"Report every database in the data root and whether it records how it was built. `layer_manifest` is " +
	"the interface (docs/engineering/reference/layer-interface.mdx); this says how much of the root implements it."

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "inventory",
	description,
	options: {
		"data-root": { type: "string", description: "Override the data root" },
		depth: { type: "string", description: "Directory levels to walk. Default 2" },
		all: { type: "boolean", default: false, description: "List every artifact; the default shows only the summary" },
		json: { type: "boolean", default: false, description: "Emit the report as JSON" },
	},
} as const satisfies CommandSpec

/**
 * The rollup is the actionable view: one builder's identical defect across many artifacts
 * reads as one problem per directory rather than one problem per file.
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

			return `  ${mark} ${String(c.manifested).padStart(3)}/${String(c.total).padEnd(4)} ${ByteFormatter.formatSI(c.bytes).padStart(10)}  ${dir}`
		})
}

const InventoryCommand: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const dataRoot = options.dataRoot ?? dataRootPath()

		const report = await takeInventory({
			dataRoot,
			...(options.depth ? { maxDepth: Number(options.depth) } : {}),
		})

		if (options.json) {
			writeRawStdout(report)

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

		// A manifest whose build command cannot run documents no usable build, reported
		// separately from the count because these artifacts pass every "has a manifest" check.
		const repoRoot = repoRootPathBuilder()

		const manifested = report.entries.filter((e) => e.provenance === Provenance.Manifested)

		const broken = (
			await Promise.all(
				manifested.map(async (e) => ({ entry: e, gaps: await buildCommandGaps(e.manifest!.build_cmd, repoRoot) }))
			)
		).filter(({ gaps }) => gaps.length)

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
				lines.push(
					`  ${entry.provenance.padEnd(14)} ${ByteFormatter.formatSI(entry.bytes).padStart(10)}  ${entry.path}`
				)

				lines.push(`  ${" ".repeat(14)} ${" ".repeat(10)}  ↳ ${rebuildHint(entry)}`)
			}
		} else {
			lines.push(``, `Pass --all to list every artifact with the command that would rebuild it.`)
		}

		writeRawStdout(`${lines.join("\n")}\n`)

		return { ok: true }
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default InventoryCommand
