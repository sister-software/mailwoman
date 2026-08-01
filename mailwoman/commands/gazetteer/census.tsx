/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer census` — build the PCN1 placetype census (hierarchy campaign R4c) from the
 *   shipped WOF admin DB. Counts each locality-class parent's children through the projection table
 *   (`gazetteer-pipeline/placetype-census.ts`), folds parent surfaces with the SAME `normalizeFSTToken`
 *   the PIX1 pair index uses — so a consumer folds once and probes both artifacts — and writes
 *   `placetype-census-<country>.bin`.
 *
 *   Fold collisions SUM. Two distinct raw parents that fold together ("St Helens" / "St. Helens") are
 *   one census node whose counts are the union of both; the serializer refuses duplicate parents, so a
 *   merge bug surfaces as a throw rather than a silently halved count.
 *
 *   `--delta` is deliberately OPTIONAL and unset by default, unlike the pair index's required one: R4c
 *   ships the census as data + loader + offline probe with NO decode wiring. A calibrated delta is a
 *   later rung's output; writing one now would put an unmeasured bias into a shipped artifact.
 *
 *   Self-verifying (the sealed-artifact spirit): after writing, the command re-reads its own bytes
 *   through a fresh `PlacetypeCensusResolver` and probes known parents, printing PROBE OK/MISS with the
 *   node's dependent-locality share and lift rather than trusting the write.
 */

import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { ComponentTag } from "@mailwoman/core/types"
import { dataRootPath, md5File } from "@mailwoman/core/utils"
import { normalizeFSTToken } from "@mailwoman/neural/fst-prior"
import {
	PlacetypeCensusResolver,
	serializePlacetypeCensus,
	type PlacetypeCensusHeader,
	type PlacetypeCensusNode,
} from "@mailwoman/neural/placetype-census"
import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { buildPlacetypeCensus, toBaseRates } from "../../gazetteer-pipeline/placetype-census.ts"

/**
 * Known parents probed after write, PER COUNTRY. Probing another country's names against a freshly built census prints
 * reassuring-looking misses that verify nothing (the lesson the pair-index command's en-nz first build taught).
 */
const PROBE_PARENTS_BY_COUNTRY: Readonly<Record<string, readonly string[]>> = {
	gb: ["London", "Manchester", "Birmingham"],
	us: ["New York", "Chicago", "Springfield"],
}

const OptionsSchema = zod.object({
	out: zod.string().default("docs/static/mailwoman").describe("Output dir for placetype-census-<country>.bin"),
	country: zod.string().default("gb").describe("ISO country code this census is built for"),
	source: zod.string().optional().describe("WOF admin DB. Default <data-root>/wof/admin-global-priority.db"),
	delta: zod
		.number()
		.optional()
		.describe(
			"OPTIONAL soft-prior magnitude written into the header. Omit (the default) for an un-wired census — R4c " +
				"ships data + loader + offline probe only; a calibration rung supplies the real value."
		),
})

export { OptionsSchema as options }

const GazetteerCensus: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const country = options.country.toLowerCase()
		const sourcePath = options.source ?? String(dataRootPath("wof", "admin-global-priority.db"))

		if (!existsSync(sourcePath)) {
			throw new Error(`census: source WOF admin DB not found: ${sourcePath}`)
		}

		const built = buildPlacetypeCensus(sourcePath, country.toUpperCase())

		if (built.unmappedPlacetypes.length) {
			throw new Error(
				`census: source carries placetypes absent from PLACETYPE_PROJECTION: ${built.unmappedPlacetypes.join(", ")} — ` +
					`extend the projection table (and plan/reference/placetype-evidence.mdx) before building.`
			)
		}

		// Fold, merging collisions by SUMMING counts — the serializer throws on duplicates, so a merge bug is loud.
		const folded = new Map<string, PlacetypeCensusNode>()
		let collisions = 0

		for (const node of built.nodes) {
			const parent = normalizeFSTToken(node.parent)

			if (!parent) continue

			const existing = folded.get(parent)

			if (!existing) {
				folded.set(parent, { parent, counts: { ...node.counts }, total: node.total })

				continue
			}

			collisions++

			for (const [tag, n] of Object.entries(node.counts) as Array<[ComponentTag, number]>) {
				existing.counts[tag] = (existing.counts[tag] ?? 0) + n
			}

			existing.total += node.total
		}

		const nodes = [...folded.values()]
		const baseRates = toBaseRates(built.countryTotals)
		const sourceMD5 = await md5File(sourcePath)

		const header: PlacetypeCensusHeader = {
			country,
			schemaVersion: 1,
			foldVersion: 1,
			sourceMD5s: [sourceMD5],
			buildDate: new Date().toISOString(),
			baseRates,
			...(options.delta !== undefined ? { delta: options.delta } : {}),
		}

		const bytes = serializePlacetypeCensus(header, nodes)
		const outPath = join(options.out, `placetype-census-${country}.bin`)

		writeFileSync(outPath, bytes)

		// Self-verifying readback over the bytes just written, not the in-memory nodes.
		const resolver = new PlacetypeCensusResolver(bytes)
		const probeParents = PROBE_PARENTS_BY_COUNTRY[country]

		if (!probeParents) {
			throw new Error(
				`census: no self-check probe parents registered for country "${country}" — add an entry to ` +
					`PROBE_PARENTS_BY_COUNTRY (probing another country's names verifies nothing).`
			)
		}

		const probeLines = probeParents.map((raw) => {
			const parent = normalizeFSTToken(raw)
			const node = resolver.probe(parent)

			if (!node) return `PROBE MISS: fold("${raw}") → "${parent}" → (no node)`

			const depLoc = node.counts.dependent_locality ?? 0
			const share = resolver.share(parent, "dependent_locality")
			const lift = resolver.lift(parent, "dependent_locality")

			return (
				`PROBE OK: "${parent}" → ${node.total.toLocaleString()} children, ` +
				`${depLoc.toLocaleString()} dependent_locality (share ${(share * 100).toFixed(1)}%, lift ${lift.toFixed(1)}×)`
			)
		})

		const baseRateLines = (Object.entries(baseRates) as Array<[ComponentTag, number]>)
			.toSorted((a, b) => b[1] - a[1])
			.map(([tag, rate]) => `  ${tag}: ${(rate * 100).toFixed(2)}%`)

		return [
			`placetype-census-${country}.bin → ${outPath} (${bytes.length.toLocaleString()} bytes)`,
			`header: ${options.delta !== undefined ? `delta=${options.delta}` : "(no delta — un-wired census)"}`,
			`nodes: ${nodes.length.toLocaleString()} (${built.nodes.length.toLocaleString()} pre-fold, ${collisions.toLocaleString()} fold collisions merged)`,
			`child links counted: ${built.links.toLocaleString()}`,
			"country base rates:",
			...baseRateLines,
			...probeLines,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerCensus
