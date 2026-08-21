/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OpenAddresses real-point resolver eval (Direction-C resolver-depth) — the NON-CIRCULAR accuracy
 *   track, and the head-to-head vs the Pelias parser. Unlike the WOF-bootstrap eval (which renders
 *   WOF places back into strings and resolves WOF→WOF), every row here is a REAL US address with a
 *   REAL government lat/lon from OpenAddresses, independent of the WOF gazetteer the resolver
 *   consults. So the great-circle error from the resolved admin centroid to OA's point is an
 *   honest, un-gamed signal.
 *
 *   Scores BOTH parsers through the same resolver: the neural classifier AND `v0` (our TypeScript
 *   port of the Pelias parser, via the flat→tree adapter). So "neural vs v0" here IS "mailwoman's
 *   neural parser vs the Pelias parser" on real addresses — no Docker Pelias stack needed, since v0
 *   already is that parser.
 *
 *   SELF-REPORTING (eval-integrity safeguard): pass `outMd` and the runner WRITES its own markdown
 *   table from the computed aggregates. Eval figures must never be hand-typed into docs — generate
 *   them here and include/commit the output verbatim.
 *
 *   Two-tier metric (per the DeepSeek resolver consult — a sub-10km coord bar is impossible for
 *   ADMIN-CENTROID resolution, since a city centroid is legitimately tens of km from edge
 *   addresses):
 *
 *   1. Admin-match Acc@1 — did we resolve to the expected locality (and/or region), by name? This is the
 *        granularity-independent resolver-quality number.
 *   2. Coord error p50/p90 — reported separately as the admin-centroid tier; the street-level tier
 *        (TIGER) will own the sub-km bar later.
 *
 *   `postcodeAnchor` adds a `neural+anchor` row: neural's admin match, but the COORDINATE taken
 *   from the postcode anchor's own centroid (`@mailwoman/neural/postcode-anchor` over the
 *   postalcode shards, `postcodeShards`). On German this drops coord p50 9.9 km → 1.2 km (p99
 *   318 → 11 km) with admin match unchanged — the postcode tier between admin-centroid and
 *   street-level.
 *
 *   Run: mailwoman eval oa-resolver\
 *   --eval data/eval/external/openaddresses-us-sample.jsonl --limit 2000\
 *   --model /tmp/v072-eval/model.onnx\
 *   --tokenizer $MAILWOMAN_DATA_ROOT/models/tokenizer/v0.6.0-a0/tokenizer.model\
 *   --model-card /tmp/v072-eval/model-card.json
 *
 *   `--wof` defaults to `admin-global-priority.db,postcode-locality-intl.db` — coordinate-first
 *   locality resolution is ON by default (no-op where the candidate table has no rows, e.g. US).
 *   Pass `--wof <admin.db>` alone for the admin-only baseline, or append a postcode shard
 *   (postalcode-*.db) to also resolve the postcode node.
 *
 *   `--anchor-off` (#887) ablates the model's postcode-anchor INPUT channel — the sanctioned,
 *   declared ablation (`overrides.anchor=false` through createScorer, warn-not-throw per the #718
 *   fail-closed gate). de-order-eval.ts uses it for the 2x2 anchor-OFF column; the old
 *   empty-anchor.json idiom (a lookup that parses to size 0) is refused by the gate. Distinct from
 *   `--postcode-anchor`, which swaps the resolved COORDINATE, not the model input.
 */

import { writeFileSync } from "node:fs"

import type { AddressTree } from "@mailwoman/core/decoder"
import { $public } from "@mailwoman/core/env"
import { dataRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"

import { renderOaResolverReport } from "./oa-resolver-report.ts"
import { dumpAggPair, newAggPair, recordInto, stateBucket } from "./oa-resolver/aggregate.ts"
import { buildAssembledArm } from "./oa-resolver/assembled-arm.ts"
import type { AnchorSources } from "./oa-resolver/coordinate-tiers.ts"
import { anchorCoordinateFor, anchorCountryPosteriorFor, buildCoordinateTiers } from "./oa-resolver/coordinate-tiers.ts"
import type { OAResolverEvalOptions } from "./oa-resolver/options.ts"
import { buildParseRig } from "./oa-resolver/parse-rig.ts"
import { scoreResolvedRow } from "./oa-resolver/row-score.ts"
import { readOARows } from "./oa-resolver/rows.ts"
import type { Resolved } from "./oa-resolver/tree-hits.ts"
import {
	collectResolved,
	findAddressPointHit,
	findInterpolatedHit,
	findInterpolationSpans,
	hasStreetHouseNumber,
} from "./oa-resolver/tree-hits.ts"

export type { Agg, AggPair } from "./oa-resolver/aggregate.ts"
export type { OAResolverEvalOptions } from "./oa-resolver/options.ts"

/**
 * Misses retained for diagnostics before the harness stops accumulating, to bound memory on a full run.
 */
const MAX_DIAGNOSTIC_MISSES = 5000

/**
 * Run the OpenAddresses real-point resolver eval. Markdown report on stdout (+ optional `outMd`).
 */
export async function oaResolverEval(
	options: OAResolverEvalOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<void> {
	const evalPath = options.eval || "data/eval/external/openaddresses-us-sample.jsonl"
	const limit = (options.limit ?? 0) || Infinity

	// Default attaches the coordinate-first candidate shard (postcode-locality-intl.db) alongside the
	// admin gazetteer, so locality resolution is coordinate-first by default for the locales it covers
	// (DE/FR/GB/NL functional). It no-ops where the table has no rows (e.g. US), so US stays unchanged.
	// Override `--wof` to measure the admin-only baseline.
	const wofPaths = (
		options.wof ||
		`${dataRootPath("wof", "admin-global-priority.db")},${dataRootPath("wof", "postcode-locality-intl.db")}`
	)
		.split(",")
		.map((s) => s.trim())

	const rows = await readOARows(evalPath, limit)

	const {
		neural,
		resolver,
		localityMatches,
		parseOpts,
		defaultCountry: dc,
		resolveOpts,
	} = await buildParseRig(options, wofPaths, reportError)

	const {
		addressPoints,
		interpolation,
		cascadeProvider,
		cascadeOn,
		runAddrPt,
		runInterp,
		useAnchor,
		anchorRerank,
		postcodeLookup,
		extractAnchors,
	} = await buildCoordinateTiers(options)

	const anchorMinConf = options.anchorMinConf ?? 0.5

	const anchorSources: AnchorSources = {
		postcodeLookup,
		extractAnchors,
		minConfidence: anchorMinConf,
		preferCountry: dc,
	}

	// Neural parser: overall + per-state aggregates. (The v0/Pelias head-to-head leg was removed with
	// the v1 rules parser in the v7 excision — its history lives in the dated eval reports.)
	const agg = {
		neural: newAggPair(),
	}

	// `neural+anchor`: neural's admin flags, but the coordinate replaced by the postcode-anchor centroid
	// when available. Only the coord error column differs from `neural`.
	const neuralAnchorAgg = newAggPair()
	const neuralAddrPtAgg = newAggPair()
	let addressPointHits = 0
	const neuralInterpAgg = newAggPair()
	let interpHits = 0
	const diagInterp = $public.MAILWOMAN_DIAG_INTERP === "1"
	let interpPrecond = 0 // rows that parsed street+house_number+postcode (interp's precondition)
	let interpFullParseMiss = 0 // precond met + exact missed + interp null = genuine find() miss
	const diagMisses: string[] = []

	const { runAssembled, assembledPipeline } = await buildAssembledArm(options, { neural, resolver }, reportError)
	const assembledAgg = newAggPair()
	let neuralPrecond = 0
	let asmPrecond = 0

	// Per-row failure dump (--errors-json): one record per row where neural OR v0 missed locality,
	// carrying each parser's resolved admin names so failures can be bucketed offline (resolve-wrong
	// vs unresolved vs neural-only vs v0-only). Aggregates are unaffected.
	const collectErrors = !!(options.errorsJSON || "")
	const errorRows: Record<string, unknown>[] = []

	// `--out-resolved <path>`: per-row dump for the PIP-containment metric (scripts/eval/pip-containment.py).
	// Carries the gold OA point + the neural-resolved locality's WOF id, so an offline pass can test
	// whether the gold point lies INSIDE the resolved locality's polygon — a name-surface-independent
	// truth check (the "Plauen" vs gold "Plauen Vogtl" name-match artifact, see the coordinate-first plan).
	const collectResolvedDump = !!(options.outResolved || "")
	const resolvedRows: Record<string, unknown>[] = []

	// `--out-rows <path>`: per-row neural-vs-v0 outcome dump (EVERY row, not just misses), for the
	// per-address-type head-to-head (scripts/eval/per-type-report.ts buckets by input shape offline).
	// Reuses the same row score the aggregates use — no extra inference, no scoring duplication.
	const collectRows = !!(options.outRows || "")
	const outRows: Record<string, unknown>[] = []

	let i = 0

	for (const row of rows) {
		i++

		if (i % 500 === 0) {
			reportError(`  ${i}/${rows.length}`)
		}

		// onnxruntime-node accumulates native tensor memory across runs faster than JS GC reclaims it
		// (~380-parse SIGKILL on the lab box — it crashed the promotion-gate's de-order step tonight).
		// Periodic forced GC reclaims it; run with `node --expose-gc`. No-op without the flag. (#787 pattern.)
		if (i % 50 === 0) {
			;(globalThis as { gc?: () => void }).gc?.()
		}

		// --cascade: per-row per-state shards (the production geocode cascade); falls back to the
		// single-state --address-points/--interpolation when --cascade is off (byte-stable default).
		const rowShards = cascadeProvider ? cascadeProvider.for((row.state || "").toLowerCase() || null) : null
		const rowAddrPoints = rowShards?.addressPoints ?? addressPoints ?? null
		const rowInterp = rowShards?.interpolation ?? interpolation ?? null

		// Shared resolve opts (hoisted so the assembled arms below resolve identically to neural).
		const nOpts = {
			...(anchorRerank
				? { ...resolveOpts, anchorPosterior: anchorCountryPosteriorFor(row.input, anchorSources) }
				: resolveOpts),
			...(rowAddrPoints ? { addressPoints: rowAddrPoints } : {}),
			...(rowInterp ? { interpolation: rowInterp } : {}),
		}

		// neural
		let nResolved: Resolved[] = []
		let nDecorated: AddressTree | null = null

		try {
			const nTree = await neural.parse(row.input, parseOpts)
			nDecorated = await resolver.resolveTree(nTree, nOpts)
			nResolved = collectResolved(nDecorated)
		} catch {
			/* unresolved */
		}

		const ns = scoreResolvedRow(row, nResolved, localityMatches)
		recordInto(agg.neural, row.state, ns)

		if (runAssembled && hasStreetHouseNumber(nDecorated)) {
			neuralPrecond++
		}

		if (collectResolvedDump) {
			resolvedRows.push({
				input: row.input,
				lat: row.lat,
				lon: row.lon,
				state: row.state,
				expectedLoc: row.expected.locality,
				neuralLocID: ns.resolvedLocID ?? null,
				neuralLoc: ns.resolvedLoc ?? null,
				nameMatch: ns.locMatch,
			})
		}

		// neural + address-points (#476): same admin flags; coordinate from the exact point on hit.
		if (runAddrPt) {
			const hit = nDecorated ? findAddressPointHit(nDecorated) : null
			const apErr = hit ? haversineKm(hit.lat, hit.lon, row.lat, row.lon) : ns.err

			if (hit) {
				addressPointHits++
			}

			recordInto(neuralAddrPtAgg, row.state, { ...ns, err: apErr })
		}

		// neural + interpolation (#483): the full street-level cascade — exact point if present, else the
		// interpolated estimate, else the admin centroid. Same admin flags; only the COORDINATE changes.
		if (runInterp) {
			const exact = nDecorated ? findAddressPointHit(nDecorated) : null
			const interp = nDecorated ? findInterpolatedHit(nDecorated) : null
			const coord = exact ?? interp
			const ipErr = coord ? haversineKm(coord.lat, coord.lon, row.lat, row.lon) : ns.err

			if (interp) {
				interpHits++
			}

			recordInto(neuralInterpAgg, row.state, { ...ns, err: ipErr })

			// --- coverage diagnostic (MAILWOMAN_DIAG_INTERP=1): split the miss cause. ---
			// The interp tier only runs in resolveTree when the exact tier did NOT stamp. So:
			//   precond met (street+house_number+postcode parsed) + exact miss + interp null
			//   ⟹ a genuine StreetInterpolator.find() miss (shard/normalization gap, NOT parse, NOT gate).
			if (diagInterp && nDecorated) {
				const { street: s, houseNumber: hn, postcode: pc } = findInterpolationSpans(nDecorated)
				const precond = !!(s && hn && pc)

				if (precond) {
					interpPrecond++
				}

				if (precond && !exact && !interp) {
					interpFullParseMiss++

					if (diagMisses.length < MAX_DIAGNOSTIC_MISSES) {
						diagMisses.push(`${hn} | ${s} | ${pc}  ←  ${row.input}`)
					}
				}
			}
		}

		// neural + postcode-anchor: same admin flags, coordinate from the anchor centroid when it has one.
		if (useAnchor) {
			const ac = anchorCoordinateFor(row.input, anchorSources)
			const fusedErr = ac ? haversineKm(ac.lat, ac.lon, row.lat, row.lon) : ns.err
			recordInto(neuralAnchorAgg, row.state, { ...ns, err: fusedErr })
		}

		if (collectRows) {
			outRows.push({
				input: row.input,
				expected: row.expected,
				neural: { loc: ns.locMatch, reg: ns.regMatch, resolved: ns.resolved, err: ns.err },
			})
		}

		// #478 inc 3 leg 2 residue: the assembled (neural pipeline) arm, through the same resolver + nOpts.
		// The arbitration variant was removed with the v1 rules parser (the rule proposer is gone).
		if (assembledPipeline) {
			try {
				const { tree } = await assembledPipeline(row.input, { resolveOpts: nOpts })
				const s = scoreResolvedRow(row, collectResolved(tree), localityMatches)

				recordInto(assembledAgg, row.state, s)

				if (hasStreetHouseNumber(tree)) {
					asmPrecond++
				}
			} catch {
				/* unresolved */
			}
		}

		if (collectErrors && !ns.locMatch) {
			errorRows.push({
				input: row.input,
				state: stateBucket(row.state),
				expected: row.expected,
				neural: {
					locMatch: ns.locMatch,
					resolved: ns.resolved,
					resolvedLoc: ns.resolvedLoc,
					resolvedReg: ns.resolvedReg,
					errKm: ns.err,
				},
			})
		}
	}

	if (collectErrors) {
		writeFileSync(options.errorsJSON || "", JSON.stringify(errorRows, null, 2))

		reportError(`wrote ${errorRows.length} failure rows → ${options.errorsJSON || ""}`)
	}

	if (collectRows) {
		writeFileSync(options.outRows || "", JSON.stringify(outRows))

		reportError(`wrote ${outRows.length} per-row outcomes → ${options.outRows || ""}`)
	}

	if (collectResolvedDump) {
		writeFileSync(options.outResolved || "", JSON.stringify(resolvedRows))

		reportError(`wrote ${resolvedRows.length} resolved rows → ${options.outResolved || ""}`)
	}

	// self-emitted; eval figures are NEVER hand-typed into docs)
	const markdown = renderOaResolverReport({
		agg,
		assembledAgg,
		neuralAnchorAgg,
		neuralAddrPtAgg,
		neuralInterpAgg,
		addressPointHits,
		interpHits,
		interpPrecond,
		interpFullParseMiss,
		neuralPrecond,
		asmPrecond,
		diagMisses,
		rows,
		wofPaths,
		runAssembled,
		runAddrPt,
		runInterp,
		useAnchor,
		diagInterp,
		cascadeOn,
		options,
	})

	report(markdown)

	if (options.outMd || "") {
		writeFileSync(options.outMd || "", markdown + "\n")

		reportError(`wrote markdown → ${options.outMd || ""}`)
	}

	if (options.outJSON || "") {
		writeFileSync(options.outJSON || "", JSON.stringify({ neural: dumpAggPair(agg.neural) }, null, 2))

		reportError(`wrote json → ${options.outJSON || ""}`)
	}

	postcodeLookup?.close()
}
