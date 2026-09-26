/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build postcode-prefix <database>` — build a PFX1 postcode-prefix index from a
 *   postcode database already in the data root.
 *
 *   `gb-codepoint` (OS Code-Point Open, OGL v3) and `gb-ni-osm` (OpenStreetMap, ODbL 1.0) are
 *   deliberately two files rather than one `postcode-prefix-gb.bin`: folding the NI nodes into the
 *   Code-Point file would put a share-alike obligation on an OGL artifact that no downstream check could
 *   see.
 *
 *   Output goes to a new dated path under `$MAILWOMAN_DATA_ROOT/postcode-prefix/`, and the file is
 *   sealed read-only afterwards.
 */

import { readLocalBuffer, pathExists } from "@mailwoman/core/fs/readers"
import { changeMode, movePath, writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import type { PostcodePrefixHeader, PostcodePrefixTier } from "@mailwoman/neural/postcode"
import { Box, Text } from "ink"
import { PathBuilder } from "path-ts"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import type { PostcodePrefixLevel } from "#gazetteer-pipeline/postcode/prefix"

/**
 * Read-only mode bits for the finished artifact — the same seal `sealDatabase` puts on a built database.
 */
const SEALED_MODE = 0o444

/**
 * Keeps the withheld-ancestry line inside one terminal row when the count runs
 * to dozens (Code-Point Open: 41).
 */
const EXAMPLES_PER_LINE = 6

interface DatabaseRecipe {
	sourceFile: string
	country: string
	scope: string
	level: PostcodePrefixLevel
	/**
	 * WOF polygon database under `<data-root>/db/wof/`, for a recipe whose ancestry
	 * is point-in-polygon rather than a documented area table.
	 */
	polygonFile?: string
	/**
	 * Probed after write; per database, never shared, because probing one register's prefixes
	 * against another index prints reassuring-looking misses that verify nothing.
	 */
	probePrefixes: readonly string[]
}

const DATABASE_RECIPES = {
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
	"us-wof": {
		sourceFile: "postalcode-us.db",
		country: "us",
		scope: "us",
		level: "3",
		polygonFile: "wof-polygons-us-full.db",
		// One prefix per behaviour the arm can produce, so a probe line that goes
		// quiet identifies the failed rule.
		probePrefixes: ["605", "946", "205", "995"],
	},
} as const satisfies Record<string, DatabaseRecipe>

type DatabaseName = keyof typeof DATABASE_RECIPES

export const description = "Build a PFX1 postcode-prefix index from a postcode database (B3-1)"

const databaseNames = ["gb-codepoint", "gb-ni-osm", "us-wof"] as const

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "postcode-prefix",
	description: "Build a postcode-prefix index",
	positionals: [{ name: "database", required: true, choices: databaseNames, description: "Database to index" }],
	options: {
		source: { type: "string", description: "Database path" },
		admin: { type: "string", description: "WOF admin DB" },
		polygons: { type: "string", description: "WOF polygon DB" },
		out: { type: "string", description: "Output path" },
		delta: { type: "number", description: "Soft-prior magnitude" },
	},
} as const satisfies CommandSpec

const GazetteerBuildPostcodePrefix: CommandComponent<typeof spec, [DatabaseName]> = ({ args, options }) => {
	const state = useCommandTask(async () => {
		const { dataRootPath } = await import("@mailwoman/core/data-root")
		const { wofDatabasePath } = await import("@mailwoman/resolver-wof-sqlite/paths")
		const { md5File, median } = await import("@mailwoman/core/utils")

		const { PostcodePrefixIndexResolver, serializePostcodePrefixIndex } = await import("@mailwoman/neural/postcode")

		const { buildPostcodePrefixIndex } = await import("#gazetteer-pipeline/postcode/prefix")

		const database = args[0] as DatabaseName
		const recipe: DatabaseRecipe = DATABASE_RECIPES[database]
		const sourcePath = options.source ?? wofDatabasePath(recipe.sourceFile)
		const adminPath = options.admin ?? wofDatabasePath("admin-global-priority.db")

		const polygonPath = recipe.polygonFile ? (options.polygons ?? wofDatabasePath(recipe.polygonFile)) : undefined

		for (const [label, path] of [
			["database", sourcePath],
			["admin DB", adminPath],
			...(polygonPath ? ([["polygon DB", polygonPath]] as const) : []),
		] as const) {
			if (!(await pathExists(path))) throw new Error(`postcode-prefix: ${label} not found: ${path}`)
		}

		const built = buildPostcodePrefixIndex({
			sourcePath,
			adminPath,
			country: recipe.country,
			level: recipe.level,
			...(polygonPath ? { polygonPath } : {}),
		})

		const buildDate = new Date().toISOString()
		const day = buildDate.slice(0, 10)

		const outPath = PathBuilder.from(
			options.out ?? dataRootPath("postcode-prefix", `postcode-prefix-${recipe.scope}-${day}.bin`)
		)

		// The database's own meta is the authority on where it came from and what it does
		// not cover, so re-deriving that prose here would let the two drift.
		const source = built.meta.source ?? "(unrecorded — the database's meta carries no `source`)"
		const attribution = built.meta.attribution ?? "(unrecorded — the database's meta carries no `attribution`)"
		const tier: PostcodePrefixTier = built.meta.tier === "build-local" ? "build-local" : "shipped"

		const coverageNote =
			(built.meta.coverage_meaning_of_zero ?? built.meta.coverage ?? "(the database's meta declares no coverage)") +
			` [PFX1: a prefix ABSENT from this index was not observed in the database above; read that as coverage, never as ` +
			`"the prefix does not exist". Nodes carry ${built.coordinateTier === "centroid" ? "a centroid and its measured radiusP95Km" : "NO coordinate — ancestry only"}: ${built.coordinateTierReason}.]`

		const header: PostcodePrefixHeader = {
			country: recipe.country,
			scope: recipe.scope,
			schemaVersion: 1,
			levels: [recipe.level],
			source,
			sourceMD5s: [
				await md5File(sourcePath),
				await md5File(adminPath),
				...(polygonPath ? [await md5File(polygonPath)] : []),
			],
			buildDate,
			tier,
			attribution,
			coverageNote,
			...(options.delta !== undefined ? { delta: options.delta } : {}),
		}

		const bytes = serializePostcodePrefixIndex(header, built.nodes)

		await makeDirectories(outPath.dirname())

		if (await pathExists(outPath)) {
			throw new Error(
				`postcode-prefix: ${outPath} already exists. Prefix indexes are dated, immutable build outputs — ` +
					`pass --out with a fresh path rather than overwriting one something may already be reading.`
			)
		}

		// Write-then-rename so a reader can never observe a half-written index, then seal.
		const tmpPath = outPath.dirname()(`.${recipe.scope}-${process.pid}.tmp`)

		await writeLocalFile(bytes, tmpPath)
		await movePath(tmpPath, outPath)
		await changeMode(outPath, SEALED_MODE)

		// Self-verifying readback: reading the buffer would verify the serializer against itself,
		// so the round-trip bar is graded from the bytes on disk.
		const resolver = new PostcodePrefixIndexResolver(await readLocalBuffer(outPath))
		const readNodes = [...resolver.nodes()]
		const readUnits = readNodes.reduce((sum, node) => sum + node.unitCount, 0)
		const readRadii = readNodes.flatMap((node) => (node.radiusP95Km === undefined ? [] : [node.radiusP95Km]))
		const withCoordinate = readNodes.filter((node) => node.lat !== undefined).length
		const readMedianRadius = median(readRadii)

		if (resolver.size !== built.nodes.length) {
			throw new Error(`postcode-prefix: round-trip node count ${resolver.size} ≠ built ${built.nodes.length}`)
		}

		if (readUnits !== built.indexedUnits) {
			throw new Error(`postcode-prefix: round-trip unitCount sum ${readUnits} ≠ ${built.indexedUnits} indexed units`)
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
			`database: ${sourcePath}`,
			`header: country=${recipe.country} scope=${recipe.scope} levels=[${recipe.level}] tier=${tier}` +
				` ${options.delta !== undefined ? `delta=${options.delta}` : "(no delta — un-wired index)"}`,
			`source (numbering register): ${source}`,
			`coordinate tier: ${built.coordinateTier} — ${built.coordinateTierReason}`,
			`ancestry withheld (the prefix spans more than one of them): ${built.borderStraddlingPrefixes.length} prefixes` +
				(built.borderStraddlingPrefixes.length
					? ` (${built.borderStraddlingPrefixes.slice(0, EXAMPLES_PER_LINE).join(", ")}${built.borderStraddlingPrefixes.length > EXAMPLES_PER_LINE ? ", …" : ""})`
					: ""),
			"round-trip (read back from the written bytes):",
			`  nodes ${resolver.size.toLocaleString()}`,
			`  unitCount sum ${readUnits.toLocaleString()} (database rows ${built.unitRows.toLocaleString()}, ${built.skippedShort} too short to cleave)`,
			...(Object.keys(built.excludedUnits).length
				? [
						`  units excluded from the coordinate: ` +
							Object.entries(built.excludedUnits)
								.map(([reason, count]) => `${reason} ${count.toLocaleString()}`)
								.join(", "),
					]
				: []),
			`  nodes with a coordinate ${withCoordinate.toLocaleString()} / ${resolver.size.toLocaleString()}`,
			`  median per-prefix radiusP95Km ${readMedianRadius === null ? "— (ancestry-only)" : `${readMedianRadius.toFixed(4)} km`}`,
			...probeLines,
		]
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
