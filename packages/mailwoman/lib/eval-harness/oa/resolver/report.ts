/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { tempRootPathBuilder } from "@mailwoman/core/data-root"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { formatPercent, percentile } from "@mailwoman/core/stats"

import type { Agg, AggPair, OAResolverEvalOptions } from "#eval-harness/oa/resolver/eval"

/**
 * Everything the report reads: the per-arm aggregates, the tier hit counts, and the run's flags.
 */
export interface OaReportInput {
	agg: { neural: AggPair }
	assembledAgg: AggPair
	neuralAnchorAgg: AggPair
	neuralAddrPtAgg: AggPair
	neuralInterpAgg: AggPair
	addressPointHits: number
	interpHits: number
	interpPrecond: number
	interpFullParseMiss: number
	neuralPrecond: number
	asmPrecond: number
	diagMisses: string[]
	rows: unknown[]
	wofPaths: string[]
	runAssembled: boolean
	runAddrPt: boolean
	runInterp: boolean
	useAnchor: boolean
	diagInterp: boolean
	cascadeOn: boolean
	options: OAResolverEvalOptions
}

/**
 * Renders the OpenAddresses resolver evaluation report as Markdown from the run's aggregates and flags.
 *
 * When interpolation diagnostics are on and there are misses, it also writes them
 * to `interp-misses.txt` under the temp root.
 */
export async function renderOaResolverReport(input: OaReportInput): Promise<string> {
	const {
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
		wofPaths,
		runAssembled,
		runAddrPt,
		runInterp,
		useAnchor,
		diagInterp,
		cascadeOn,
		options,
	} = input

	const p = (xs: number[], q: number): string => percentile(xs, q)?.toFixed(1) ?? "—"

	const lines: string[] = [
		`# OpenAddresses real-point resolver eval (${agg.neural.overall.n} rows, non-circular)`,
		"",
		`Model: ${options.model || "(shipped weights)"} | WOF databases: ${wofPaths.length}`,
		"",
		`## Resolver eval — neural parser through the WOF resolver`,
		"",
		`| parser | locality-match | region-match | resolved | coord p50 km | coord p90 km | p99 km |`,
		`|---|--:|--:|--:|--:|--:|--:|`,
	]

	const overallRow = (label: string, a: Agg): string =>
		`| ${label} | ${formatPercent(a.localityMatch, a.n)} | ${formatPercent(a.regionMatch, a.n)} | ${formatPercent(a.resolved, a.n)} | ${p(a.errs, 50)} | ${p(a.errs, 90)} | ${p(a.errs, 99)} |`

	lines.push(overallRow("**neural**", agg.neural.overall))

	if (runAssembled) {
		lines.push(overallRow("assembled", assembledAgg.overall))
	}

	if (useAnchor) {
		lines.push(overallRow("**neural+anchor**", neuralAnchorAgg.overall))
	}

	if (runAddrPt) {
		lines.push(overallRow("**neural+addrpt**", neuralAddrPtAgg.overall))
		lines.push("")

		lines.push(
			`address-point hit rate: ${addressPointHits}/${neuralAddrPtAgg.overall.n} (${((100 * addressPointHits) / Math.max(1, neuralAddrPtAgg.overall.n)).toFixed(1)}%)`
		)
	}

	if (runInterp) {
		lines.push(
			overallRow(cascadeOn ? "**neural+cascade (SHIPPED coord)**" : "**neural+interp**", neuralInterpAgg.overall)
		)

		lines.push("")

		lines.push(
			`interpolation hit rate (interp coord without exact point): ${interpHits}/${neuralInterpAgg.overall.n} (${((100 * interpHits) / Math.max(1, neuralInterpAgg.overall.n)).toFixed(1)}%)`
		)

		if (cascadeOn) {
			const Nc = neuralInterpAgg.overall.n
			const adminTier = Math.max(0, Nc - addressPointHits - interpHits)
			const cerrs = neuralInterpAgg.overall.errs

			const within = (m: number): string =>
				`${((100 * cerrs.filter((e) => e <= m / 1000).length) / Math.max(1, cerrs.length)).toFixed(1)}%`

			lines.push("")

			lines.push(
				`**neural+cascade** is the PRODUCTION coordinate (mailwoman/geocode-core.ts: address_point > interpolated > admin, per-state databases) — what mailwoman actually ships, vs the admin-centroid **neural** row above. Tier share: address_point ${formatPercent(addressPointHits, Nc)}, interpolated ${formatPercent(interpHits, Nc)}, admin ${formatPercent(adminTier, Nc)}. Within 100 m: ${within(100)} · within 1 km: ${within(1000)} (n=${cerrs.length}).`
			)
		}

		if (diagInterp) {
			const N = neuralInterpAgg.overall.n
			lines.push("")
			lines.push(`### interp coverage diagnostic`)

			lines.push(
				`- parsed street+house_number+postcode (precondition): ${interpPrecond}/${N} (${((100 * interpPrecond) / Math.max(1, N)).toFixed(1)}%)`
			)

			lines.push(
				`- precondition met + exact missed + interp MISS (genuine find() miss = database/normalization gap): ${interpFullParseMiss}`
			)

			lines.push(
				`- interp HITS: ${interpHits} → of full-parse non-exact rows, hit rate ${((100 * interpHits) / Math.max(1, interpFullParseMiss + interpHits)).toFixed(1)}%`
			)

			const ierrs = neuralInterpAgg.overall.errs
			lines.push("")
			lines.push(`error CDF (neural+interp, n=${ierrs.length}) — cumulative % within radius:`)

			for (const m of [10, 25, 50, 100, 200, 500, 1000, 5000]) {
				const within = ierrs.filter((e) => e <= m / 1000).length
				lines.push(`  ≤ ${m} m: ${((100 * within) / Math.max(1, ierrs.length)).toFixed(1)}%`)
			}

			if (diagMisses.length) {
				const missesPath = tempRootPathBuilder("interp-misses.txt")
				await writeLocalTextFile(diagMisses.join("\n"), missesPath)
				lines.push("")
				lines.push(`full-parse interp misses dumped: ${diagMisses.length} → ${missesPath}`)
				lines.push("sample (house_number | street | postcode ← input):")

				for (const m of diagMisses.slice(0, 12)) {
					lines.push(`  - ${m}`)
				}
			}
		}
	}

	if (runAssembled) {
		const N = agg.neural.overall.n
		lines.push("")
		lines.push(`### Assembled-pipeline coordinate check`)
		lines.push("")

		lines.push(
			"`assembled` is the pipeline through the same neural+resolver (comparability check vs `neural`). The street+house_number **precondition** (parsed both, the thing #566 broke) per arm:"
		)

		lines.push("")

		lines.push(
			`- neural: ${formatPercent(neuralPrecond, N)} · assembled: ${formatPercent(asmPrecond, N)} (of ${N} rows)`
		)
	}

	lines.push("")
	lines.push(`## Neural per-state (locality-match)`)
	lines.push("")
	lines.push(`| state | n | neural loc | neural reg |`)
	lines.push(`|---|--:|--:|--:|`)

	for (const st of [...agg.neural.byState.keys()].toSorted()) {
		const nn = agg.neural.byState.get(st)!

		lines.push(
			`| ${st} | ${nn.n} | ${formatPercent(nn.localityMatch, nn.n)} | ${formatPercent(nn.regionMatch, nn.n)} |`
		)
	}

	lines.push("")

	lines.push(
		`Coord error for **neural** is the ADMIN-CENTROID tier (locality/region centroid → OA's real` +
			` address point); a city centroid is legitimately tens of km from edge addresses, so the admin-MATCH` +
			` rate is the headline there, not the coord. **neural+anchor** swaps in the postcode anchor's own` +
			` centroid for the coordinate (admin match unchanged) — the finer postcode tier between admin-centroid` +
			` and street-level (TIGER), which will own the sub-km tier later.`
	)

	return lines.join("\n")
}
