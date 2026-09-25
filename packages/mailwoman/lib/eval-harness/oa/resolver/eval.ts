/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { AddressTree } from "@mailwoman/core/decoder"
import { writeLocalJSONFile, writeLocalFile } from "@mailwoman/core/fs/writers"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { haversineKm } from "@mailwoman/spatial"

import { $public } from "#env"
import { dumpAggPair, newAggPair, recordInto, stateBucket } from "#eval-harness/oa/resolver/aggregate"
import { buildAssembledArm } from "#eval-harness/oa/resolver/assembled-arm"
import type { AnchorSources } from "#eval-harness/oa/resolver/coordinate-tiers"
import {
	anchorCoordinateFor,
	anchorCountryPosteriorFor,
	buildCoordinateTiers,
} from "#eval-harness/oa/resolver/coordinate-tiers"
import type { OAResolverEvalOptions } from "#eval-harness/oa/resolver/options"
import { buildParseRig } from "#eval-harness/oa/resolver/parse-rig"
import { writeRunProfile } from "#eval-harness/oa/resolver/profile"
import { renderOaResolverReport } from "#eval-harness/oa/resolver/report"
import { scoreResolvedRow } from "#eval-harness/oa/resolver/row-score"
import { readOARows } from "#eval-harness/oa/resolver/rows"
import type { Resolved } from "#eval-harness/oa/resolver/tree-hits"
import {
	collectResolved,
	findAddressPointHit,
	findInterpolatedHit,
	findInterpolationSpans,
	hasStreetHouseNumber,
} from "#eval-harness/oa/resolver/tree-hits"

/**
 * Re-exports the aggregate counter types so that report code can import them from the eval module.
 */
export type { Agg, AggPair } from "#eval-harness/oa/resolver/aggregate"
/**
 * Re-exports the options type that {@linkcode oaResolverEval} accepts.
 */
export type { OAResolverEvalOptions } from "#eval-harness/oa/resolver/options"

const MAX_DIAGNOSTIC_MISSES = 5000

/**
 * Run the OpenAddresses resolver eval.
 */
export async function oaResolverEval(
	options: OAResolverEvalOptions = {},
	report: (line: string) => void = console.log,
	reportError: (line: string) => void = console.error
): Promise<void> {
	const evalPath = options.eval || "data/eval/external/openaddresses-us-sample.jsonl"
	const limit = (options.limit ?? 0) || Infinity

	const wofPaths = (
		options.wof || `${wofDatabasePath("admin-global-priority.db")},${wofDatabasePath("postcode-locality-intl.db")}`
	)
		.split(",")
		.map((s) => s.trim())

	const rows = await readOARows(evalPath, limit)
	const setupStartedAt = performance.now()

	const {
		neural,
		resolver,
		localityMatches,
		parseOpts,
		defaultCountry: dc,
		resolveOpts,
		lookupCensus,
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

	const timing = { setupMs: performance.now() - setupStartedAt, loopStartedAt: performance.now(), parse: 0, resolve: 0 }

	const anchorMinConf = options.anchorMinConf ?? 0.5

	const anchorSources: AnchorSources = {
		postcodeLookup,
		extractAnchors,
		minConfidence: anchorMinConf,
		preferCountry: dc,
	}

	const agg = {
		neural: newAggPair(),
	}

	const neuralAnchorAgg = newAggPair()
	const neuralAddrPtAgg = newAggPair()
	let addressPointHits = 0
	const neuralInterpAgg = newAggPair()
	let interpHits = 0
	const diagInterp = $public.MAILWOMAN_DIAG_INTERP === "1"
	let interpPrecond = 0
	let interpFullParseMiss = 0
	const diagMisses: string[] = []

	const { runAssembled, assembledPipeline } = await buildAssembledArm(options, { neural, resolver }, reportError)
	const assembledAgg = newAggPair()
	let neuralPrecond = 0
	let asmPrecond = 0

	const collectErrors = !!(options.errorsJSON || "")
	const errorRows: Record<string, unknown>[] = []

	const collectResolvedDump = !!(options.outResolved || "")
	const resolvedRows: Record<string, unknown>[] = []

	const collectRows = !!(options.outRows || "")
	const outRows: Record<string, unknown>[] = []

	let i = 0

	for (const row of rows) {
		i++

		if (i % 500 === 0) {
			reportError(`  ${i}/${rows.length}`)
		}

		if (i % 50 === 0) {
			;(globalThis as { gc?: () => void }).gc?.()
		}

		const rowDatabases = cascadeProvider ? cascadeProvider.for((row.state || "").toLowerCase() || null) : null
		const rowAddrPoints = rowDatabases?.addressPoints ?? addressPoints ?? null
		const rowInterp = rowDatabases?.interpolation ?? interpolation ?? null

		const nOpts = {
			...(anchorRerank
				? { ...resolveOpts, anchorPosterior: anchorCountryPosteriorFor(row.input, anchorSources) }
				: resolveOpts),
			...(rowAddrPoints ? { addressPoints: rowAddrPoints } : {}),
			...(rowInterp ? { interpolation: rowInterp } : {}),
		}

		let nResolved: Resolved[] = []
		let nDecorated: AddressTree | null = null

		try {
			const parseStartedAt = performance.now()
			const nTree = await neural.parse(row.input, parseOpts)
			const resolveStartedAt = performance.now()

			nDecorated = await resolver.resolveTree(nTree, nOpts)
			timing.parse += resolveStartedAt - parseStartedAt
			timing.resolve += performance.now() - resolveStartedAt
			nResolved = collectResolved(nDecorated)
		} catch {}

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

		if (runAddrPt) {
			const hit = nDecorated ? findAddressPointHit(nDecorated) : null
			const apErr = hit ? haversineKm(hit.lat, hit.lon, row.lat, row.lon) : ns.err

			if (hit) {
				addressPointHits++
			}

			recordInto(neuralAddrPtAgg, row.state, { ...ns, err: apErr })
		}

		if (runInterp) {
			const exact = nDecorated ? findAddressPointHit(nDecorated) : null
			const interp = nDecorated ? findInterpolatedHit(nDecorated) : null
			const coord = exact ?? interp
			const ipErr = coord ? haversineKm(coord.lat, coord.lon, row.lat, row.lon) : ns.err

			if (interp) {
				interpHits++
			}

			recordInto(neuralInterpAgg, row.state, { ...ns, err: ipErr })

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

		if (useAnchor) {
			const ac = anchorCoordinateFor(row.input, anchorSources)
			const fusedErr = ac ? haversineKm(ac.lat, ac.lon, row.lat, row.lon) : ns.err
			recordInto(neuralAnchorAgg, row.state, { ...ns, err: fusedErr })
		}

		if (collectRows) {
			outRows.push({
				input: row.input,
				expected: row.expected,

				neural: {
					loc: ns.locMatch,
					reg: ns.regMatch,
					resolved: ns.resolved,
					err: ns.err,
					...(ns.resolvedLoc === undefined ? {} : { resolvedLoc: ns.resolvedLoc }),
					...(ns.resolvedReg === undefined ? {} : { resolvedReg: ns.resolvedReg }),
				},
			})
		}

		if (assembledPipeline) {
			try {
				const { tree } = await assembledPipeline(row.input, { resolveOpts: nOpts })
				const s = scoreResolvedRow(row, collectResolved(tree), localityMatches)

				recordInto(assembledAgg, row.state, s)

				if (hasStreetHouseNumber(tree)) {
					asmPrecond++
				}
			} catch {}
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

	await writeRunProfile(options.profileJSON || "", {
		evalPath,
		rows: rows.length,
		defaultCountry: dc,
		anchorOff: !!options.anchorOff,
		lookupMemo: !!options.lookupMemo,
		timing,
		census: lookupCensus,
	})

	if (collectErrors) {
		await writeLocalJSONFile(errorRows, options.errorsJSON || "")

		reportError(`wrote ${errorRows.length} failure rows → ${options.errorsJSON || ""}`)
	}

	if (collectRows) {
		await writeLocalJSONFile(outRows, options.outRows || "")

		reportError(`wrote ${outRows.length} per-row outcomes → ${options.outRows || ""}`)
	}

	if (collectResolvedDump) {
		await writeLocalJSONFile(resolvedRows, options.outResolved || "")

		reportError(`wrote ${resolvedRows.length} resolved rows → ${options.outResolved || ""}`)
	}

	const markdown = await renderOaResolverReport({
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
		await writeLocalFile(markdown + "\n", options.outMd || "")

		reportError(`wrote markdown → ${options.outMd || ""}`)
	}

	if (options.outJSON || "") {
		await writeLocalJSONFile({ neural: dumpAggPair(agg.neural) }, options.outJSON || "")

		reportError(`wrote json → ${options.outJSON || ""}`)
	}

	postcodeLookup?.[Symbol.dispose]()
}
