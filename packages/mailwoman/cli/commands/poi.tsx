// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman poi "<query>" [flags]` — POI-query intent probe (spec §3.1–3.4, exotic-POI arc plans 2 + 4).
 *
 *   Runs the runtime pipeline with `poiQueryKind` on and prints whatever the intent
 *   stage decided: the matched subject + anchor, an abstain reason, or executed results
 *   when `--db` points at a sealed `poi.db` layer (`mailwoman gazetteer build poi`).
 *   `--overpass` additionally renders the OverpassQL export block (`@mailwoman/poi-overpass`) —
 *   export-only, mailwoman never queries Overpass itself.
 *
 *   A non-POI query (kind classifier never emits `poi_query`, or the intent stage fell through)
 *   reports that and exits 0.
 *   This command is a debug probe rather than a strict POI-only parser.
 *
 *   Exit-code interface:
 *
 *   - 0 on any completed probe, including "no POI intent" and abstain results.
 *   - 1 on a missing positional query or a fatal pipeline error.
 *
 *   Resolver wiring: an anchor remainder ("near Springfield IL") only gains a searchable center
 *   when the pipeline's `resolver` stage decorates the anchor's parsed tree with lat/lon —
 *   `poi-executor.ts`'s `resolveCenter` walks the tree for that.
 *   `--db` queries abstain with `anchor_required` without it.
 *
 *   `openPOIAnchorResolver` in `#poi/anchor-resolver` builds the resolver,
 *   and the POI board builds its own there too.
 *   A missing gazetteer leaves the probe without a resolver, with a stderr note,
 *   and anchors keep zero coordinates.
 */

import { Spinner } from "@inkjs/ui"
import { prettyJSON } from "@mailwoman/core/json"
import type { POIIntent, POIQueryResult, POIResult } from "@mailwoman/core/pipeline"
import { CommandError } from "@mailwoman/core/scripting/command"
import { DEFAULT_WEIGHTS_LOCALE } from "@mailwoman/neural/weights/families"
import { Text } from "ink"

import {
	type CommandSpec,
	CommandTaskResult,
	isLocaleTag,
	loadClassifierTolerant,
	type OptionsOf,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
	writeRawStdout,
} from "#cli-kit"
import { typedLocaleHint } from "#cli/kit/locale-hint"
import type { POIAnchorResolver } from "#poi/anchor-resolver"

/**
 * Native command-line interface consumed by the filesystem command router.
 */
export const spec = {
	name: "poi",
	description: "Parse and execute a POI-shaped query",
	positionals: [{ name: "query", required: true, multiple: true, description: "POI query" }],
	options: {
		locale: {
			type: "string",
			default: DEFAULT_WEIGHTS_LOCALE,
			validate: isLocaleTag,
			description: "BCP-47 locale",
		},
		db: { type: "string", description: "Sealed poi.db layer" },
		overpass: { type: "boolean", default: false, description: "Print an OverpassQL export block" },
		json: { type: "boolean", default: false, description: "Emit raw JSON" },
		"resolve-db": { type: "string", description: "WOF database for anchor resolution" },
		"candidate-db": { type: "string", description: "Candidate database for anchor resolution" },
	},
} as const satisfies CommandSpec

type Options = OptionsOf<typeof spec>

/**
 * Opens the anchor resolver through `openPOIAnchorResolver`, so an anchor remainder resolves
 * to a coordinate and a `--db` category or brand query can compute a search center.
 *
 * An absent gazetteer or an uninstalled `@mailwoman/resolver-wof-sqlite` peer leaves the probe
 * without a resolver instead of failing it, and a stderr note states which one is missing.
 * The caller disposes the returned resolver.
 */
async function tryLoadResolver(options: Options): Promise<POIAnchorResolver | null> {
	const { openPOIAnchorResolver } = await import("#poi/anchor-resolver")

	const opened = await openPOIAnchorResolver({
		...(options.candidateDB ? { candidateDB: options.candidateDB } : {}),
		...(options.resolveDB ? { resolveDB: options.resolveDB } : {}),
	})

	if (opened === "unconfigured") {
		console.error(
			"note: no WOF resolver configured — anchor localities ('near Springfield IL') will not resolve to " +
				"coordinates, so --db category/brand queries will abstain anchor_required. Set $MAILWOMAN_WOF_DB " +
				"(or $MAILWOMAN_CANDIDATE_DB) or pass --resolve-db/--candidate-db. Build one with " +
				"`mailwoman gazetteer build admin` + `mailwoman gazetteer build fts`."
		)

		return null
	}

	if (opened === "unavailable") {
		console.error(
			"note: `@mailwoman/resolver-wof-sqlite` is not installed — anchor localities will not resolve to " +
				"coordinates. Run `npm install @mailwoman/resolver-wof-sqlite` to enable anchor resolution."
		)

		return null
	}

	return opened
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
		// Every member needs a tag rather than only one: a union emitted from the subset that
		// happens to include `osmTag` is a narrower query than the one the POI branch ran.
		// The printed result would hide that difference.
		const untagged = categoryIDs.filter((id) => !getPOICategory(id)?.osmTag)

		if (untagged.length) {
			return `(no OverpassQL export — ${untagged.length === 1 ? "category" : "categories"} '${untagged.join("', '")}' ${untagged.length === 1 ? "has" : "have"} no osmTag mapping in @mailwoman/poi-taxonomy)`
		}

		return emitOverpassQL(intent, { osmTags: categoryIDs.map((id) => getPOICategory(id)!.osmTag!) })
	}

	return emitOverpassQL(intent)
}

/**
 * Compact ancestry suffix, e.g. "· Springfield, IL, US" — locality/region/country entries,
 * coarsest-last (the hierarchy's own deepest-first order reversed), skipping other
 * placetypes (county, neighborhood, …) to keep the table narrow.
 *
 * Empty string when `ancestry` is absent (no reverse geocoder wired) or contains no
 * entries of those three tiers (e.g. open-ocean/approximate misses).
 */
function formatAncestrySuffix(ancestry: POIResult["ancestry"]): string {
	if (!ancestry || !ancestry.length) return ""
	const byPlacetype = new Map(ancestry.map((a) => [a.placetype, a.name]))
	const parts = ["locality", "region", "country"].map((t) => byPlacetype.get(t)).filter((name) => name)

	return parts.length ? ` · ${parts.join(", ")}` : ""
}

function formatResultsTable(results: NonNullable<Extract<POIQueryResult, { type: "intent" }>["results"]>): string[] {
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
				(r.distanceM != null ? String(Math.round(r.distanceM)) : "-").padStart(10),
				r.latitude.toFixed(6).padStart(12),
				r.longitude.toFixed(6).padStart(12),
			].join("  ") + formatAncestrySuffix(r.ancestry)
		)
	}

	return lines
}

async function formatResult(result: POIQueryResult, options: Options): Promise<string> {
	const lines: string[] = []

	if (result.type === "abstain") {
		lines.push(`abstain: ${result.reason}`)

		return lines.join("\n")
	}

	const { intent, results } = result
	lines.push(`subject: ${formatSubject(intent.subject)}`)

	if (intent.anchor?.text) {
		lines.push(`anchor: ${intent.anchor.text}`)
	}

	lines.push("")

	if (!results) {
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

async function runPOI(input: string, options: Options, localeHint: { locale?: string }): Promise<string> {
	const { createRuntimePipeline } = await import("#engine/runtime-pipeline")

	// An attempted-but-failed encoder load always reports its failure.
	// Absent weights produce an install hint.
	// A corrupt bundle surfaces its underlying error.
	// Stderr only.
	// Stdout stays the probe output.
	const classifier = await loadClassifierTolerant(options.locale, { onDegrade: reportToStderr })
	const resolverHandle = await tryLoadResolver(options)

	try {
		const poiQueryKind = options.db ? { poiDatabasePath: options.db } : "extract"

		await using pipeline = createRuntimePipeline({
			classifier: classifier ?? undefined,
			resolver: resolverHandle?.resolver,
			poiQueryKind,
		})

		// The weights above follow `--locale`, default included.
		// The pipeline takes it as a hint only when typed.
		const result = await pipeline(input, localeHint)

		if (options.json) {
			return prettyJSON(result.poiIntent ?? null)
		}

		if (result.path !== "poi" || !result.poiIntent) {
			return (
				`no POI intent — parsed as address ` +
				`(kind: ${result.kind.kind}, confidence: ${result.kind.confidence.toFixed(2)})`
			)
		}

		return await formatResult(result.poiIntent, options)
	} finally {
		resolverHandle?.[Symbol.dispose]()
	}
}

const PoiCommand: ParsedCommandComponent<Options> = ({ options, args, typed }) => {
	const state = useCommandTask(async () => {
		const input = args[0]

		if (!input || !input.trim()) {
			throw new CommandError(
				'mailwoman poi requires a positional query (e.g. mailwoman poi "fire hydrant near Springfield")'
			)
		}

		return runPOI(input.trim(), options, typedLocaleHint(typed, options.locale))
	})

	if (state.status !== "done") {
		return <CommandTaskResult state={state} running={<Spinner />} />
	}

	// --json dumps raw JSON.
	// Bypass Ink's word-wrapping <Text> renderer.
	// It corrupts long lines at 80 cols when piped (see writeRawStdout).
	if (options.json) {
		return writeRawStdout(state.result)
	}

	return <Text>{state.result}</Text>
}

export default PoiCommand
