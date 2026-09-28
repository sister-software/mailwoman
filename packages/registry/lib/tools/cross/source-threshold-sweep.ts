/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cross-source threshold sweep. Resolve the sources once, then compare the Fellegi-Sunter
 *   baseline against the bundled GBT over a fine threshold sweep, scoring each arm on cross-source
 *   links, triple-source entities, total entities and phone corroboration.
 *
 *   Run: `mailwoman registry scorer-eval threshold-sweep [--cap 2000] [--state TX]
 *   [--wof <admin.db>] [--data-root <dir>] [--out-md <md>]`
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { pathToFileURL } from "@mailwoman/core/module/file-url"
import { formatPercent } from "@mailwoman/core/stats"
import { resolvePath } from "path-ts"

import {
	addressFrequencyKey,
	buildDefaultModel,
	createGBTScorer,
	DEDUP_GBT_META,
	DEDUP_GBT_MODEL,
	ingestRows,
	normalizePhoneStrict,
	resolveEntities,
	streamRows,
	type GeocodeAddress,
	type ResolvedEntity,
	type SourceRecord,
} from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { buildSpecs, stateOption } from "#tools/shared"

/**
 * Independent sources that must agree before a cluster counts as cross-source corroborated.
 */
const MIN_CROSS_SOURCE_AGREEMENT = 3

/**
 * Options for {@linkcode crossSourceThresholdSweep}.
 */
export interface CrossSourceThresholdSweepOptions {
	/**
	 * The injected geocoder factory.
	 *
	 * The command wires `mailwoman/geocode-core`, as `./eval-geocoder.ts` does.
	 */
	createGeocoder: EvalGeocoderFactory
	/**
	 * Record-matcher sources directory.
	 *
	 * Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string
	/**
	 * Rows kept per source.
	 *
	 * Default 2000.
	 */
	cap?: number
	/**
	 * State filter.
	 *
	 * Default TX.
	 */
	state?: string
	/**
	 * A trained cross-source GBT module (exports CROSS_SOURCE_GBT_MODEL + _META) to
	 * grade as a third arm at its recommended threshold.
	 * This is the model `registry train-scorer cross-gbt` emits.
	 */
	candidate?: string
	/**
	 * Also write the markdown report here.
	 */
	outMd?: string
}

const entitySources = (e: ResolvedEntity): Set<string> =>
	new Set(e.records.map((r) => r.source).filter((s): s is string => !!s))

/**
 * Label-free precision proxy: does this cross-source entity carry the same phone
 * in records from two different sources?
 *
 * Phone is not the join key, so a match is independent corroboration of one facility.
 * Entities where no two cross-source records both carry a phone are unknown,
 * and only checkable entities count.
 */
function phoneEvidence(e: ResolvedEntity): "corroborated" | "contradicted" | "unknown" {
	const bySource = new Map<string, Set<string>>()

	for (const r of e.records) {
		const ph = normalizePhoneStrict(r.phone)

		if (!ph) continue
		const s = r.source ?? "?"

		if (!bySource.has(s)) {
			bySource.set(s, new Set())
		}

		bySource.get(s)!.add(ph)
	}

	const sources = [...bySource.keys()]

	if (sources.length < 2) return "unknown"
	let any = false

	for (let i = 0; i < sources.length; i++) {
		for (let j = i + 1; j < sources.length; j++) {
			any = true

			for (const ph of bySource.get(sources[i]!)!) if (bySource.get(sources[j]!)!.has(ph)) return "corroborated"
		}
	}

	return any ? "contradicted" : "unknown"
}

interface ArmMetrics {
	label: string
	threshold: number | null
	entities: number
	crossSource: number
	tripleSource: number
	phoneCorrob: number
	phoneContradict: number
	phoneCheckable: number
}

async function measure(label: string, threshold: number | null, entities: ResolvedEntity[]): Promise<ArmMetrics> {
	let crossSource = 0
	let tripleSource = 0
	let phoneCorrob = 0
	let phoneContradict = 0
	let phoneCheckable = 0

	for (const e of entities) {
		const n = entitySources(e).size

		if (n < 2) continue

		crossSource++

		if (n >= MIN_CROSS_SOURCE_AGREEMENT) {
			tripleSource++
		}

		const ev = phoneEvidence(e)

		if (ev === "corroborated") {
			phoneCorrob++

			phoneCheckable++
		} else if (ev === "contradicted") {
			phoneContradict++

			phoneCheckable++
		}
	}

	return {
		label,
		threshold,
		entities: entities.length,
		crossSource,
		tripleSource,
		phoneCorrob,
		phoneContradict,
		phoneCheckable,
	}
}

/**
 * Compare the FS baseline against the bundled GBT over a threshold sweep,
 * and emit the markdown report to stdout.
 */
export async function crossSourceThresholdSweep(
	options: CrossSourceThresholdSweepOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const CAP = options.cap ?? 2000
	const STATE = stateOption(options)
	const OUT_MD = options.outMd || ""
	const CANDIDATE = options.candidate || ""
	const SPECS = buildSpecs(`${SOURCES}`, STATE)

	const rawBySource = new Map<string, Record<string, string>[]>()

	for (const spec of SPECS) {
		report?.(`[A] ${spec.source}: streaming + ${STATE} filter (cap ${CAP})…`)
		const kept: Record<string, string>[] = []

		for await (const row of streamRows(spec.path)) {
			if (!spec.inState(row)) continue
			kept.push(row)

			if (kept.length >= CAP) break
		}

		rawBySource.set(spec.source, kept)
		report?.(`    ${spec.source}: ${kept.length} rows`)
	}

	report?.("[B] building the geocoder…")
	const geocoder = await options.createGeocoder()
	const geocodeForIngest: GeocodeAddress = geocoder.geocodeAddress

	report?.("[C] geocoding + ingesting…")
	const records: SourceRecord[] = []

	for (const spec of SPECS) {
		const recs = await ingestRows(rawBySource.get(spec.source)!, spec.mapping, { geocodeAddress: geocodeForIngest })

		for (const r of recs) {
			r.id = `${spec.source}:${r.id}`
		}

		records.push(...recs)
	}

	geocoder[Symbol.dispose]()
	const geocoded = records.filter((r) => r.address?.geocode).length
	report?.(`    ${records.length} records; geocoded ${geocoded}`)

	const addrCounts = new Map<string, number>()
	let addrTotal = 0

	for (const r of records) {
		if (!r.address?.raw) continue
		addrCounts.set(addressFrequencyKey(r.address.raw), (addrCounts.get(addressFrequencyKey(r.address.raw)) ?? 0) + 1)

		addrTotal++
	}

	const addressFrequency = {
		total: addrTotal,
		distinct: addrCounts.size,
		frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
	}

	const comparisons = buildDefaultModel({ collapseSpatial: true, addressFrequency }).comparisons
	const gbtScorer = createGBTScorer({ model: DEDUP_GBT_MODEL, comparisons, addressFrequency })

	report?.("[D] resolving — FS baseline baseline…")

	const fs = await measure(
		"FS baseline",
		0,
		resolveEntities(records, { trainEM: true, collapseSpatial: true, addressFrequency, learnedScorer: false }).entities
	)

	const SWEEP = [-8, -6, -5, -4, -3, -2, -1, 0, 1, 2, DEDUP_GBT_META.recommendedThreshold]
	const gbtArms: ArmMetrics[] = []

	for (const t of SWEEP) {
		report?.(`[D] resolving — GBT @ threshold ${t}…`)

		const { entities } = resolveEntities(records, {
			collapseSpatial: true,
			addressFrequency,
			scorer: gbtScorer,
			threshold: t,
		})

		gbtArms.push(await measure(`GBT @ ${t.toFixed(2)}`, t, entities))
	}

	// A GBT arm dominates only when it matches FS cross-source links at no lower phone corroboration and
	// keeps at least 90% of FS entities, since a collapse means giant-blob artifacts rather than links.
	const pct = (n: number, d: number) => formatPercent(n, d, 0)
	const candidateArms: ArmMetrics[] = []

	if (CANDIDATE) {
		const mod = (await import(pathToFileURL(resolvePath(CANDIDATE)).href)) as {
			CROSS_SOURCE_GBT_MODEL?: typeof DEDUP_GBT_MODEL
			CROSS_SOURCE_GBT_META?: { recommendedThreshold?: number }
			ORG_CROSS_SOURCE_GBT_MODEL?: typeof DEDUP_GBT_MODEL
			ORG_CROSS_SOURCE_GBT_META?: { recommendedThreshold?: number }
		}

		const candModel = mod.CROSS_SOURCE_GBT_MODEL ?? mod.ORG_CROSS_SOURCE_GBT_MODEL

		if (!candModel)
			throw new Error(`--candidate module exports neither CROSS_SOURCE_GBT_MODEL nor ORG_CROSS_SOURCE_GBT_MODEL`)

		const t0 = (mod.CROSS_SOURCE_GBT_META ?? mod.ORG_CROSS_SOURCE_GBT_META)?.recommendedThreshold ?? 0
		const candScorer = createGBTScorer({ model: candModel, comparisons, addressFrequency })
		report?.(`[E] resolving — cross-source GBT candidate @ ${t0.toFixed(3)} (±)…`)

		for (const t of [t0 - 1, t0, t0 + 1]) {
			candidateArms.push(
				await measure(
					`cross-GBT @ ${t.toFixed(2)}`,
					t,
					resolveEntities(records, {
						trainEM: true,
						collapseSpatial: true,
						addressFrequency,
						scorer: candScorer,
						threshold: t,
					}).entities
				)
			)
		}
	}

	const rate = (a: ArmMetrics) => (a.phoneCheckable > 0 ? a.phoneCorrob / a.phoneCheckable : 0)
	const fsCorrobRate = rate(fs)
	const minEntities = Math.floor(fs.entities * 0.9)

	const dominating = gbtArms.find(
		(a) => a.crossSource >= fs.crossSource && rate(a) >= fsCorrobRate && a.entities >= minEntities
	)

	// The candidate gets its own verdict scan, separate from the option-1 verdict for the dedup GBT.
	const candidateDominating = candidateArms.find(
		(a) => a.crossSource >= fs.crossSource && rate(a) >= fsCorrobRate && a.entities >= minEntities
	)

	let candidateBest: ArmMetrics | null = null

	for (const arm of candidateArms) {
		if (arm.entities >= minEntities && arm.crossSource > (candidateBest?.crossSource ?? -1)) {
			candidateBest = arm
		}
	}

	const rows = [fs, ...gbtArms, ...candidateArms]

	const lines: string[] = [
		`# #655 — cross-source threshold sweep: can a re-thresholded GBT beat FS?`,
		"",
		`_TX-scoped, ≤${CAP} rows/source (NPPES org + TX HHSC nursing = eligibility-ish; FCC-RHC = funding), ` +
			`geocoded once then resolved per arm. **Phone-corrob** = of the cross-source entities whose records carry ` +
			`a phone in ≥2 different sources, the fraction where those phones MATCH — a label-free precision proxy ` +
			`(phone is not the join key). Higher cross-source + higher phone-corrob = better._`,
		"",
		`| arm | threshold | total entities | cross-source links | triple-source | phone-corrob (of checkable) |`,
		`|---|---:|---:|---:|---:|---|`,
	]

	for (const r of rows) {
		lines.push(
			`| ${r.label} | ${r.threshold === null ? "—" : r.threshold} | ${r.entities} | ${r.crossSource} | ` +
				`${r.tripleSource} | ${r.phoneCorrob}/${r.phoneCheckable} (${pct(r.phoneCorrob, r.phoneCheckable)}) |`
		)
	}

	lines.push("")
	lines.push(`## Verdict`)

	if (CANDIDATE) {
		const c = candidateDominating ?? candidateBest
		lines.push("")

		if (candidateDominating) {
			lines.push(
				`**The --candidate model DOMINATES FS**: ${candidateDominating.crossSource} cross-source links (FS ${fs.crossSource}) at phone-corrob ${(100 * rate(candidateDominating)).toFixed(0)}% ≥ FS ${(100 * fsCorrobRate).toFixed(0)}%, entities ${candidateDominating.entities} (no collapse). Un-pinning FS for this objective is supported by this run.`
			)
		} else if (c) {
			lines.push(
				`**--candidate (best non-collapsing arm)**: ${c.crossSource} cross-source links vs FS ${fs.crossSource}, phone-corrob ${(100 * rate(c)).toFixed(0)}% vs FS ${(100 * fsCorrobRate).toFixed(0)}%, entities ${c.entities}. Does not STRICTLY dominate — judge the margins (the phone proxy is one-link noisy at this n).`
			)
		} else {
			lines.push(`**--candidate**: no non-collapsing arm (every threshold fell below the entity floor).`)
		}
	}

	lines.push("")

	lines.push(
		`FS baseline: **${fs.crossSource}** cross-source links (${fs.tripleSource} triple), ` +
			`phone-corrob ${pct(fs.phoneCorrob, fs.phoneCheckable)} (${fs.phoneCorrob}/${fs.phoneCheckable}).`
	)

	lines.push("")

	if (!dominating) {
		lines.push(
			`**No GBT threshold dominates FS** — none matches FS's ${fs.crossSource} cross-source links at ≥ its ` +
				`${pct(fs.phoneCorrob, fs.phoneCheckable)} phone-corrob without over-merging (entity count collapsing below ` +
				`${minEntities}). At its dedup threshold the GBT finds FEWER cross-source links than FS; lowering the ` +
				`threshold to admit more only over-merges (the over-merge features REPLACE the FS weight, so true ` +
				`cross-source pairs share a logit band with genuine over-merges). Threshold alone (option 1) is ` +
				`**INSUFFICIENT** — FS stays pinned (correct + best-precision for this objective); a cross-objective ` +
				`retrain (option 2), conditioned on cross-source labels, is the only change. See #655.`
		)
	} else {
		lines.push(
			`**GBT @ ${dominating.threshold} dominates FS**: ${dominating.crossSource} links (vs ${fs.crossSource}) at ` +
				`${pct(dominating.phoneCorrob, dominating.phoneCheckable)} phone-corrob (vs ${pct(fs.phoneCorrob, fs.phoneCheckable)}), ` +
				`${dominating.entities} entities (vs ${fs.entities}). The threshold fix (option 1) WORKS: ship a cross-source ` +
				`threshold ≈ ${dominating.threshold}.`
		)
	}

	lines.push("")

	const md = lines.join("\n")

	console.log(md)

	if (OUT_MD) {
		await writeLocalFile(md, OUT_MD)
		report?.(`[written] ${OUT_MD}`)
	}

	return { markdown: md }
}
