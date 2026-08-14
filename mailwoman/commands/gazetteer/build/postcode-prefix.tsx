/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-prefix <shard>` — build a PFX1 postcode-prefix index
 *   (postcode-structure arc, B3-1) from a postcode shard already in the data root.
 *
 *   Two shards, and they are DELIBERATELY TWO FILES rather than one `postcode-prefix-gb.bin`:
 *
 *   - `gb-codepoint` → `postcode-prefix-gb-esw.bin`. 2,863 outward codes from OS Code-Point Open
 *       (OGL v3, shippable tier), each with a centroid and its measured `radiusP95Km`. Code-Point Open
 *       covers England, Scotland and Wales ONLY — the scope slug says so, because a file named for the
 *       whole country while missing a constituent one is the coverage confusion the shard's own meta
 *       spends three keys warning about.
 *   - `gb-ni-osm` → `postcode-prefix-gb-ni.bin`. 80 BT districts from OpenStreetMap, ANCESTRY-ONLY,
 *       no coordinates. ODbL 1.0, so BUILD-LOCAL: folding these nodes into the Code-Point file would
 *       put a share-alike obligation on an OGL artifact, and nothing downstream could see it had
 *       happened. That licence split — not the format — is why the two GB registers stay apart.
 *
 *   Self-verifying (the sealed-artifact spirit, PCN1's posture): after writing, the command re-reads
 *   THE FILE — not the buffer still in memory, which would only verify the serializer against itself
 *   — through a fresh `PostcodePrefixIndexResolver`, and reports the round-trip totals: node count,
 *   summed `unitCount`, the median per-prefix `radiusP95Km`. Those three numbers are B3-1's bar, so
 *   the bar is graded by reading the artifact rather than by the builder's memory of it.
 *
 *   Output goes to a NEW DATED path under `$MAILWOMAN_DATA_ROOT/postcode-prefix/`. Nothing is
 *   overwritten, and the file is sealed read-only afterwards.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import type { PostcodePrefixHeader, PostcodePrefixTier } from "@mailwoman/neural/postcode-prefix-index"
import { Box, Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"
import type { PostcodePrefixLevel } from "mailwoman/gazetteer-pipeline/postcode-prefix"

/**
 * Read-only mode bits for the finished artifact — the same seal `sealDatabase` puts on a built database. A prefix index
 * is a build output, not a file anything edits in place.
 */
const SEALED_MODE = 0o444

/**
 * How many example prefixes a summary line names before eliding. Cosmetic — it keeps the withheld-ancestry line inside
 * one terminal row when the count runs to dozens (Code-Point Open: 41).
 */
const EXAMPLES_PER_LINE = 6

interface ShardRecipe {
	/**
	 * Shard filename under `<data-root>/wof/`.
	 */
	sourceFile: string
	country: string
	/**
	 * Sub-national scope slug — the header field AND the filename suffix.
	 */
	scope: string
	level: PostcodePrefixLevel
	/**
	 * Prefixes probed after write. Per SHARD, never shared: probing Code-Point prefixes against a freshly built NI index
	 * prints reassuring-looking misses that verify nothing (the lesson the pair-index command's en-nz first build
	 * taught).
	 */
	probePrefixes: readonly string[]
}

const SHARD_RECIPES = {
	"gb-codepoint": {
		sourceFile: "postalcode-gb-codepoint.db",
		country: "gb",
		scope: "gb-esw",
		level: "outward",
		probePrefixes: ["SW1A", "EH1", "CF10", "M1"],
	},
	"gb-ni-osm": {
		sourceFile: "postalcode-ni-osm.db",
		country: "gb",
		scope: "gb-ni",
		level: "outward",
		probePrefixes: ["BT1", "BT9", "BT48", "BT94"],
	},
} as const satisfies Record<string, ShardRecipe>

type ShardName = keyof typeof SHARD_RECIPES

export const description = "Build a PFX1 postcode-prefix index from a postcode shard (B3-1)"

const shardNames = ["gb-codepoint", "gb-ni-osm"] as const

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-prefix",
	description: "Build a postcode-prefix index",
	positionals: [{ name: "shard", required: true, choices: shardNames, description: "Shard to index" }],
	options: {
		source: { type: "string", description: "Shard path" },
		admin: { type: "string", description: "WOF admin DB" },
		out: { type: "string", description: "Output path" },
		delta: { type: "number", description: "Soft-prior magnitude" },
	},
} as const satisfies CommandSpec

interface Options {
	source?: string
	admin?: string
	out?: string
	delta?: number
}

const GazetteerBuildPostcodePrefix: ParsedCommandComponent<Options, [ShardName]> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath, md5File, median } = await import("@mailwoman/core/utils")

		const { PostcodePrefixIndexResolver, serializePostcodePrefixIndex } =
			await import("@mailwoman/neural/postcode-prefix-index")

		const { buildPostcodePrefixIndex } = await import("mailwoman/gazetteer-pipeline/postcode-prefix")

		const shard = args[0] as ShardName
		const recipe: ShardRecipe = SHARD_RECIPES[shard]
		const sourcePath = options.source ?? String(dataRootPath("wof", recipe.sourceFile))
		const adminPath = options.admin ?? String(dataRootPath("wof", "admin-global-priority.db"))

		for (const [label, path] of [
			["shard", sourcePath],
			["admin DB", adminPath],
		] as const) {
			if (!existsSync(path)) throw new Error(`postcode-prefix: ${label} not found: ${path}`)
		}

		const built = buildPostcodePrefixIndex({
			sourcePath,
			adminPath,
			country: recipe.country,
			level: recipe.level,
		})

		const buildDate = new Date().toISOString()
		const day = buildDate.slice(0, 10)

		const outPath = options.out ?? String(dataRootPath("postcode-prefix", `postcode-prefix-${recipe.scope}-${day}.bin`))

		// The shard's own meta is the authority on where it came from and what it does not cover — re-deriving that prose
		// here would let the two drift, and the shard is the one that knows.
		const source = built.meta.source ?? "(unrecorded — the shard's meta carries no `source`)"
		const attribution = built.meta.attribution ?? "(unrecorded — the shard's meta carries no `attribution`)"
		const tier: PostcodePrefixTier = built.meta.tier === "build-local" ? "build-local" : "shipped"

		const coverageNote =
			(built.meta.coverage_meaning_of_zero ?? built.meta.coverage ?? "(the shard's meta declares no coverage)") +
			` [PFX1: a prefix ABSENT from this index was not observed in the shard above; read that as coverage, never as ` +
			`"the prefix does not exist". Nodes carry ${built.coordinateTier === "centroid" ? "a centroid and its measured radiusP95Km" : "NO coordinate — ancestry only"}: ${built.coordinateTierReason}.]`

		const header: PostcodePrefixHeader = {
			country: recipe.country,
			scope: recipe.scope,
			schemaVersion: 1,
			levels: [recipe.level],
			source,
			sourceMD5s: [await md5File(sourcePath), await md5File(adminPath)],
			buildDate,
			tier,
			attribution,
			coverageNote,
			...(options.delta !== undefined ? { delta: options.delta } : {}),
		}

		const bytes = serializePostcodePrefixIndex(header, built.nodes)

		mkdirSync(dirname(outPath), { recursive: true })

		if (existsSync(outPath)) {
			throw new Error(
				`postcode-prefix: ${outPath} already exists. Prefix indexes are dated, immutable build outputs — ` +
					`pass --out with a fresh path rather than overwriting one something may already be reading.`
			)
		}

		// Write-then-rename so a reader can never observe a half-written index, then seal.
		const tmpPath = join(dirname(outPath), `.${recipe.scope}-${process.pid}.tmp`)

		writeFileSync(tmpPath, bytes)
		renameSync(tmpPath, outPath)
		chmodSync(outPath, SEALED_MODE)

		// ── Self-verifying readback: B3-1's bar, graded by re-reading the FILE, not the buffer still in
		// memory. Reading the buffer would verify the serializer against itself and prove nothing about
		// what landed on disk — the whole point of a round-trip bar.
		const resolver = new PostcodePrefixIndexResolver(readFileSync(outPath))
		const readNodes = [...resolver.nodes()]
		const readUnits = readNodes.reduce((sum, node) => sum + node.unitCount, 0)
		const readRadii = readNodes.flatMap((node) => (node.radiusP95Km === undefined ? [] : [node.radiusP95Km]))
		const withCoordinate = readNodes.filter((node) => node.lat !== undefined).length
		const readMedianRadius = median(readRadii)

		if (resolver.size !== built.nodes.length) {
			throw new Error(`postcode-prefix: round-trip node count ${resolver.size} ≠ built ${built.nodes.length}`)
		}

		if (readUnits !== built.unitRows - built.skippedShort) {
			throw new Error(
				`postcode-prefix: round-trip unitCount sum ${readUnits} ≠ ${built.unitRows - built.skippedShort} indexed units`
			)
		}

		const probeLines = recipe.probePrefixes.map((prefix) => {
			const node = resolver.probe(prefix)

			if (!node) return `PROBE MISS: "${prefix}" → (no node)`

			const ancestry = node.ancestors.map((a) => `${a.name}(${a.placetype} ${a.wofID})`).join(" › ")

			const place =
				node.lat === undefined
					? "no coordinate (ancestry-only)"
					: `${node.lat.toFixed(4)},${node.lon!.toFixed(4)} ±p95 ${node.radiusP95Km!.toFixed(2)} km`

			return `PROBE OK: "${prefix}" → ${node.unitCount.toLocaleString()} units, ${ancestry}, ${place}`
		})

		return [
			`postcode-prefix-${recipe.scope}.bin → ${outPath} (${bytes.length.toLocaleString()} bytes, sealed 0444)`,
			`shard: ${sourcePath}`,
			`header: country=${recipe.country} scope=${recipe.scope} levels=[${recipe.level}] tier=${tier}` +
				` ${options.delta !== undefined ? `delta=${options.delta}` : "(no delta — un-wired index)"}`,
			`source (numbering register): ${source}`,
			`coordinate tier: ${built.coordinateTier} — ${built.coordinateTierReason}`,
			`ancestry withheld (border-straddling postcode areas): ${built.borderStraddlingPrefixes.length} prefixes` +
				(built.borderStraddlingPrefixes.length
					? ` (${built.borderStraddlingPrefixes.slice(0, EXAMPLES_PER_LINE).join(", ")}${built.borderStraddlingPrefixes.length > EXAMPLES_PER_LINE ? ", …" : ""})`
					: ""),
			"round-trip (read back from the written bytes):",
			`  nodes ${resolver.size.toLocaleString()}`,
			`  unitCount sum ${readUnits.toLocaleString()} (shard rows ${built.unitRows.toLocaleString()}, ${built.skippedShort} too short to cleave)`,
			`  nodes with a coordinate ${withCoordinate.toLocaleString()} / ${resolver.size.toLocaleString()}`,
			`  median per-prefix radiusP95Km ${readMedianRadius === null ? "— (ancestry-only)" : `${readMedianRadius.toFixed(4)} km`}`,
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

export default GazetteerBuildPostcodePrefix
