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
 *   fell through) reports that and exits 0 — this command is a debug probe, not a strict
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

import { Spinner } from "@inkjs/ui"
import type { POIIntent, POIIntentOutcome, POIResult } from "@mailwoman/core/pipeline"
import type { Resolver } from "@mailwoman/core/resolver"
import { CommandError } from "@mailwoman/core/scripting/command"
import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	loadClassifierTolerant,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "poi",
	description: "Parse and execute a POI-shaped query",
	positionals: [{ name: "query", required: true, multiple: true, description: "POI query" }],
	options: {
		locale: {
			type: "string",
			default: "en-US",
			validate: (value: string) => /^[a-z]{2}(-[A-Z]{2})?$/u.test(value),
			description: "BCP-47 locale",
		},
		db: { type: "string", description: "Sealed poi.db layer" },
		overpass: { type: "boolean", default: false, description: "Print an OverpassQL export block" },
		json: { type: "boolean", default: false, description: "Emit raw JSON" },
		"resolve-db": { type: "string", description: "WOF database for anchor resolution" },
		"candidate-db": { type: "string", description: "Candidate database for anchor resolution" },
	},
} as const satisfies CommandSpec

interface Options {
	locale: string
	db?: string
	overpass: boolean
	json: boolean
	resolveDB?: string
	candidateDB?: string
}

/**
 * Try to build the WOF resolver (same backend selector `geocode.tsx`/`parse.tsx --resolve` use), so an anchor remainder
 * resolves to lat/lon and `--db` category/brand queries can compute a search center. Lazy + optional: an absent
 * gazetteer or an unbuilt `@mailwoman/resolver-wof-sqlite` peer degrades to no resolver (today's pre-wiring behavior)
 * rather than failing the probe — a stderr note explains what's missing. Caller owns closing the returned handle's
 * backend lookup.
 */
async function tryLoadResolver(options: Options): Promise<({ resolver: Resolver } & Disposable) | undefined> {
	const { resolvePOIResolverPaths } = await import("#resolver-backend")

	const { candidateDB, wofPaths } = await resolvePOIResolverPaths({
		candidateDB: options.candidateDB,
		resolveDB: options.resolveDB,
	})

	if (!candidateDB && !wofPaths.length) {
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
		const { createResolverBackend } = await import("#resolver-backend")
		const { createWOFResolver } = await import("@mailwoman/resolver")
		const lookup = await createResolverBackend(mod, { candidateDB: options.candidateDB, wofPaths })

		return { resolver: createWOFResolver(lookup), [Symbol.dispose]: () => lookup[Symbol.dispose]() }
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
			return `category ${subject.categoryIDs.join(" + ")} (matched "${subject.matched}")`
		case "brand":
			return `brand ${subject.name}${subject.wikidata ? ` [${subject.wikidata}]` : ""} (matched "${subject.matched}")`
		case "name":
			return `name "${subject.text}"`
	}
}

/**
 * Resolve the OverpassQL block, or a clear message when a category subject has no osmTag mapping.
 */
async function formatOverpassBlock(intent: POIIntent): Promise<string> {
	const { emitOverpassQL } = await import("@mailwoman/poi-taxonomy/overpass")

	if (intent.subject.kind === "category") {
		const { getPOICategory } = await import("@mailwoman/poi-taxonomy")
		const { categoryIDs } = intent.subject
		// EVERY member needs a tag, not just one: a union emitted from the subset that happens to carry `osmTag` is a
		// narrower query than the one the POI branch ran, and the difference would be invisible in the printed result.
		const untagged = categoryIDs.filter((id) => !getPOICategory(id)?.osmTag)

		if (untagged.length) {
			return `(no OverpassQL export — ${untagged.length === 1 ? "category" : "categories"} '${untagged.join("', '")}' ${untagged.length === 1 ? "has" : "have"} no osmTag mapping in @mailwoman/poi-taxonomy)`
		}

		return emitOverpassQL(intent, { osmTags: categoryIDs.map((id) => getPOICategory(id)!.osmTag!) })
	}

	return emitOverpassQL(intent)
}

/**
 * Compact ancestry suffix, e.g. "· Springfield, IL, US" — locality/region/country entries, coarsest-last (the
 * hierarchy's own deepest-first order reversed), skipping other placetypes (county, neighbourhood, …) to keep the table
 * narrow. Empty string when `ancestry` is absent (no reverse geocoder wired) or carries none of those three tiers (e.g.
 * open-ocean/approximate misses).
 */
function formatAncestrySuffix(ancestry: POIResult["ancestry"]): string {
	if (!ancestry || !ancestry.length) return ""
	const byPlacetype = new Map(ancestry.map((a) => [a.placetype, a.name]))
	const parts = ["locality", "region", "country"].map((t) => byPlacetype.get(t)).filter((name) => name !== undefined)

	return parts.length ? ` · ${parts.join(", ")}` : ""
}

function formatResultsTable(results: NonNullable<Extract<POIIntentOutcome, { type: "intent" }>["results"]>): string[] {
	if (!results.length) return ["(no results)"]

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
			].join("  ") + formatAncestrySuffix(r.ancestry)
		)
	}

	return lines
}

async function formatOutcome(outcome: POIIntentOutcome, options: Options): Promise<string> {
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
		lines.push(await formatOverpassBlock(intent))
	}

	return lines.join("\n")
}

async function runPOI(input: string, options: Options): Promise<string> {
	const { createRuntimePipeline } = await import("#index")

	// #1108: an attempted-but-failed encoder load is never silent — absent weights get an install hint,
	// a corrupt bundle surfaces its underlying error. Stderr only; stdout stays the probe output.
	const classifier = await loadClassifierTolerant(options.locale, { onDegrade: reportToStderr })
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
		resolverHandle?.[Symbol.dispose]()
	}
}

const PoiCommand: ParsedCommandComponent<Options> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const input = args[0]

		if (!input || !input.trim().length) {
			throw new CommandError(
				'mailwoman poi requires a positional query (e.g. mailwoman poi "fire hydrant near Springfield")'
			)
		}

		return await runPOI(input.trim(), options)
	})

	if (state.status !== "done") {
		return <CommandTaskResult state={state} running={<Spinner />} />
	}

	// --json dumps raw JSON — bypass Ink's word-wrapping <Text> renderer, which corrupts long
	// lines at 80 cols when piped (see writeRawStdout).
	if (options.json) {
		return writeRawStdout(state.result)
	}

	return <Text>{state.result}</Text>
}

export default PoiCommand
