/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman poi "<query>" [flags]` — POI-query intent probe (spec §3.1–3.4, exotic-POI arc plans
 *   2 + 4). Runs the runtime pipeline with `poiQueryKind` on and prints whatever the intent stage
 *   decided: the matched subject + anchor, an abstain reason, or executed results when `--db` points
 *   at a sealed `poi.db` layer (`mailwoman gazetteer build poi`). `--overpass` additionally renders
 *   the OverpassQL export block (`@mailwoman/poi-overpass`) — export-only, mailwoman never queries
 *   Overpass itself. A non-POI query (kind classifier never emits `poi_query`, or the intent stage
 *   fell through) reports that plainly and exits 0 — this command is a debug probe, not a strict
 *   POI-only parser.
 *
 *   Exit-code contract:
 *
 *   - 0 on any completed probe, including "no POI intent" and abstain outcomes.
 *   - 1 on a missing positional query or a fatal pipeline error.
 *
 *   Resolver wiring: an anchor remainder ("near Springfield IL") only gains a searchable center when the
 *   pipeline's `resolver` stage decorates the anchor's parsed tree with lat/lon — `poi-executor.ts`'s
 *   `resolveCenter` walks the tree for that, and `--db` queries abstain `anchor_required` without it. Mirrors
 *   `geocode.tsx`/`parse.tsx --resolve`: the same `createResolverBackend` + `createWOFResolver(lookup)`
 *   pairing, lazily built and closed after the run. A missing/unbuilt gazetteer degrades to today's behavior
 *   (no resolver — anchors stay coordinate-less) with a stderr note, never a hard failure.
 */

import { existsSync } from "node:fs"

import { Spinner } from "@inkjs/ui"
import type { POIIntent, POIIntentOutcome } from "@mailwoman/core/pipeline"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { getPOICategory } from "@mailwoman/poi-taxonomy"
import { createWOFResolver, type Resolver } from "@mailwoman/resolver"
import { Text } from "ink"
import { createRuntimePipeline } from "mailwoman"
import zod from "zod"

import { type CommandComponent, commandError, useCommandTask } from "../cli-kit/index.ts"
import { emitOverpassQL } from "../poi-overpass.ts"
import { createResolverBackend, resolveCandidateDBPath, wofShardPaths } from "../resolver-backend.ts"

const ArgumentsSchema = zod.array(zod.string().describe("A POI-shaped query, e.g. 'fire hydrant near Springfield'"))
export { ArgumentsSchema as args, OptionsSchema as options }

const OptionsSchema = zod.object({
	locale: zod
		.string()
		.regex(/^[a-z]{2}(-[A-Z]{2})?$/u, "Expected a BCP-47 tag like en-US or fr-FR")
		.optional()
		.default("en-US")
		.describe("Locale tag matching a weights package (en-US, fr-FR). Default en-US."),
	db: zod
		.string()
		.optional()
		.describe(
			"Path to a sealed poi.db layer (mailwoman gazetteer build poi). When set, the matched intent is EXECUTED " +
				"against it (results attached, or an anchor_required abstain). Absent = intent-only mode: the subject is " +
				"still extracted and the build-local abstain (requires_build_local_layer) still fires."
		),
	overpass: zod
		.boolean()
		.optional()
		.default(false)
		.describe(
			"Additionally print an OverpassQL export block for the matched intent (spec §1: export-only — mailwoman " +
				"never runs the query itself). A category with no @mailwoman/poi-taxonomy osmTag mapping prints a " +
				"message instead of throwing."
		),
	json: zod
		.boolean()
		.optional()
		.default(false)
		.describe("Dump the raw POIIntentOutcome as JSON instead of the human-readable summary."),
	resolveDb: zod
		.string()
		.optional()
		.describe(
			"Path to a WOF admin SQLite distribution for anchor resolution ('near Springfield IL' -> lat/lon). " +
				"Defaults to $MAILWOMAN_WOF_DB, else the standard per-deployment shard set under $MAILWOMAN_DATA_ROOT " +
				"(same default `mailwoman geocode` uses). Missing entirely -> anchors stay coordinate-less (a note is " +
				"printed) and --db queries abstain anchor_required."
		),
	candidateDb: zod
		.string()
		.optional()
		.describe(
			"Path to a byte-range candidate.db (build-candidate.ts) for anchor resolution — the demo-parity, " +
				"population-first backend. Defaults to $MAILWOMAN_CANDIDATE_DB; when present it wins over --resolve-db."
		),
})

/** Try to load the neural classifier; undefined lets the rule-based kind/fast-path stages still run. */
async function tryLoadNeural(locale: string): Promise<NeuralAddressClassifier | undefined> {
	try {
		return await NeuralAddressClassifier.loadFromWeights({ locale })
	} catch {
		return undefined
	}
}

/**
 * Try to build the WOF resolver (same backend selector `geocode.tsx`/`parse.tsx --resolve` use), so an anchor remainder
 * resolves to lat/lon and `--db` category/brand queries can compute a search center. Lazy + optional: an absent
 * gazetteer or an unbuilt `@mailwoman/resolver-wof-sqlite` peer degrades to no resolver (today's pre-wiring behavior)
 * rather than failing the probe — a stderr note explains what's missing. Caller owns closing the returned handle's
 * backend lookup.
 */
async function tryLoadResolver(
	options: zod.infer<typeof OptionsSchema>
): Promise<{ resolver: Resolver; close: () => void } | undefined> {
	const candidateDb = resolveCandidateDBPath(options.candidateDb)
	const wofPaths = candidateDb
		? []
		: (options.resolveDb ? options.resolveDb.split(",").map((p) => p.trim()) : wofShardPaths()).filter((p) =>
				existsSync(p)
			)

	if (!candidateDb && wofPaths.length === 0) {
		console.error(
			"note: no WOF resolver configured — anchor localities ('near Springfield IL') will not resolve to " +
				"coordinates, so --db category/brand queries will abstain anchor_required. Set $MAILWOMAN_WOF_DB " +
				"(or $MAILWOMAN_CANDIDATE_DB) or pass --resolve-db/--candidate-db. Build one with " +
				"`mailwoman gazetteer build admin` + `mailwoman gazetteer build fts`."
		)

		return undefined
	}

	try {
		const mod = await import("@mailwoman/resolver-wof-sqlite")
		const lookup = createResolverBackend(mod, { candidateDb: options.candidateDb, wofPaths })

		return { resolver: createWOFResolver(lookup), close: () => lookup.close() }
	} catch {
		console.error(
			"note: `@mailwoman/resolver-wof-sqlite` is not installed — anchor localities will not resolve to " +
				"coordinates. Run `npm install @mailwoman/resolver-wof-sqlite` to enable anchor resolution."
		)

		return undefined
	}
}

function formatSubject(subject: POIIntent["subject"]): string {
	switch (subject.kind) {
		case "category":
			return `category ${subject.categoryID} (matched "${subject.matched}")`
		case "brand":
			return `brand ${subject.name}${subject.wikidata ? ` [${subject.wikidata}]` : ""} (matched "${subject.matched}")`
		case "name":
			return `name "${subject.text}"`
	}
}

/** Resolve the OverpassQL block, or a clear message when a category subject has no osmTag mapping. */
function formatOverpassBlock(intent: POIIntent): string {
	if (intent.subject.kind === "category") {
		const category = getPOICategory(intent.subject.categoryID)

		if (!category?.osmTag) {
			return `(no OverpassQL export — category '${intent.subject.categoryID}' has no osmTag mapping in @mailwoman/poi-taxonomy)`
		}

		return emitOverpassQL(intent, { osmTag: category.osmTag })
	}

	return emitOverpassQL(intent)
}

function formatResultsTable(results: NonNullable<Extract<POIIntentOutcome, { type: "intent" }>["results"]>): string[] {
	if (results.length === 0) return ["(no results)"]

	const lines = [
		"name                            category            distance_m  lat          lon",
		"──────────────────────────────  ──────────────────  ──────────  ───────────  ───────────",
	]

	for (const r of results) {
		lines.push(
			[
				(r.name ?? "(unnamed)").slice(0, 30).padEnd(31),
				(r.categoryID ?? "-").slice(0, 18).padEnd(20),
				(r.distanceM !== undefined ? String(Math.round(r.distanceM)) : "-").padStart(10),
				r.latitude.toFixed(6).padStart(12),
				r.longitude.toFixed(6).padStart(12),
			].join("  ")
		)
	}

	return lines
}

function formatOutcome(outcome: POIIntentOutcome, options: zod.infer<typeof OptionsSchema>): string {
	const lines: string[] = []

	if (outcome.type === "abstain") {
		lines.push(`abstain: ${outcome.reason}`)

		return lines.join("\n")
	}

	const { intent, results } = outcome
	lines.push(`subject: ${formatSubject(intent.subject)}`)

	if (intent.anchor?.text) {
		lines.push(`anchor: ${intent.anchor.text}`)
	}

	lines.push("")

	if (results === undefined) {
		lines.push("(intent only — no --db lookup configured)")
	} else {
		lines.push(...formatResultsTable(results))
	}

	if (options.overpass) {
		lines.push("")
		lines.push("OverpassQL:")
		lines.push(formatOverpassBlock(intent))
	}

	return lines.join("\n")
}

async function runPOI(input: string, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	const classifier = await tryLoadNeural(options.locale)
	const resolverHandle = await tryLoadResolver(options)

	try {
		const poiQueryKind = options.db ? { poiDatabasePath: options.db } : true
		const pipeline = createRuntimePipeline({ classifier, resolver: resolverHandle?.resolver, poiQueryKind })
		const result = await pipeline(input, { locale: options.locale })

		if (options.json) {
			return JSON.stringify(result.poiIntent ?? null, null, 2)
		}

		if (result.path !== "poi" || !result.poiIntent) {
			return (
				`no POI intent — parsed as address ` +
				`(kind: ${result.kind.kind}, confidence: ${result.kind.confidence.toFixed(2)})`
			)
		}

		return formatOutcome(result.poiIntent, options)
	} finally {
		resolverHandle?.close()
	}
}

const PoiCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const input = args[0]

		if (!input || input.trim().length === 0) {
			throw commandError(
				'mailwoman poi requires a positional query (e.g. mailwoman poi "fire hydrant near Springfield")'
			)
		}

		return runPOI(input.trim(), options)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return <Spinner />
	}

	return <Text>{state.result}</Text>
}

export default PoiCommand
