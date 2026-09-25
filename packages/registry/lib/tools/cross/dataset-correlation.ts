/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"

import {
	addressFrequencyKey,
	ingestRows,
	repName,
	resolveEntities,
	streamRows,
	toGeoJSON,
	type GeocodeAddress,
	type SourceRecord,
} from "#index"
import type { EvalGeocoderFactory } from "#tools/eval-geocoder"
import { buildSpecs, norm, pct, stateOption, type SourceSpec } from "#tools/shared"

const MIN_TRIPLE_SOURCES = 3

/**
 * Options for {@linkcode crossDatasetCorrelation}.
 */
export interface CrossDatasetCorrelationOptions {
	/**
	 * Creates the geocoder that resolves the sampled rows.
	 */
	createGeocoder: EvalGeocoderFactory

	/**
	 * The record-matcher sources directory.
	 *
	 * It defaults to `$MAILWOMAN_DATA_ROOT/record-matcher/sources`.
	 */
	sources?: string

	/**
	 * The number of in-state rows sampled per source for geocoding.
	 * It defaults to 300.
	 */
	cap?: number

	/**
	 * The state filter.
	 * It defaults to `TX`.
	 */
	state?: string

	/**
	 * Whether to scan every in-state row to build a corpus-wide address-frequency table.
	 * It defaults to true.
	 *
	 * The scan reads the full source files, including the multi-gigabyte NPPES file.
	 * When it is false, `resolveEntities` computes frequencies from the sample alone.
	 */
	corpusFrequency?: boolean

	/**
	 * An optional path for the Markdown report.
	 */
	outMd?: string

	/**
	 * An optional path for the entity GeoJSON FeatureCollection.
	 */
	outGeojson?: string
}

function composeAddress(row: Record<string, string>, columns: string | string[] | undefined): string {
	if (!columns) return ""
	const list = Array.isArray(columns) ? columns : [columns]

	return list
		.map((c) => norm(row[c]))
		.filter(isPresent)
		.join(" ")
		.trim()
}

const commitmentsSpec = (S: string, STATE: string): SourceSpec => ({
	source: "fcc-rhc-commitments",
	path: `${S}/fcc-rhc_commitments-disbursements_form462-466-466a_20260615.tsv`,
	mapping: {
		id: "hcpID",
		organization: "hcpName",
		address: ["hcpStreet", "hcpCity", "hcpState", "hcpZip"],
		source: "fcc-rhc-commitments",
	},
	inState: (r) =>
		norm(r["Filing HCP State"]).toUpperCase() === STATE || norm(r["Participating HCP State"]).toUpperCase() === STATE,
	explode: (r) => {
		const out: Record<string, string>[] = []

		const add = (prefix: string, role: string): void => {
			const id = norm(r[`${prefix} HCP`])
			const state = norm(r[`${prefix} HCP State`]).toUpperCase()

			if (id && state === STATE) {
				out.push({
					hcpID: `${role}-${id}`,
					hcpName: norm(r[`${prefix} HCP Name`]),
					hcpStreet: norm(r[`${prefix} HCP Street`]),
					hcpCity: norm(r[`${prefix} HCP City`]),
					hcpState: state,
					hcpZip: norm(r[`${prefix} HCP Zip Code`]),
				})
			}
		}

		add("Filing", "filing")
		add("Participating", "participating")

		return out
	},
})

/**
 * Geocodes a sample of each source dataset in one state, resolves the records into
 * entities across sources, and returns a Markdown report of the cross-source links.
 *
 * Progress lines go to `report`.
 * The function also writes the report and GeoJSON when `outMd` or `outGeojson` is set.
 */
export async function crossDatasetCorrelation(
	options: CrossDatasetCorrelationOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const CAP = options.cap ?? 300
	const STATE = stateOption(options)
	const OUT_MD = options.outMd || ""
	const OUT_GEOJSON = options.outGeojson || ""
	const CORPUS_FREQ = options.corpusFrequency ?? true
	const SPECS = [...buildSpecs(`${SOURCES}`, STATE), commitmentsSpec(`${SOURCES}`, STATE)]

	const rawBySource = new Map<string, Record<string, string>[]>()
	const addrCounts = new Map<string, number>()
	let addrTotal = 0

	for (const spec of SPECS) {
		report?.(`[A] ${spec.source}: streaming + ${STATE} filter (sample ${CAP}${CORPUS_FREQ ? ", full freq scan" : ""})…`)
		const kept: Record<string, string>[] = []

		for await (const row of streamRows(spec.path)) {
			if (!spec.inState(row)) continue
			const exploded = spec.explode ? spec.explode(row) : [row]

			for (const e of exploded) {
				if (CORPUS_FREQ) {
					const a = composeAddress(e, spec.mapping.address)

					if (a) {
						const k = addressFrequencyKey(a)
						addrCounts.set(k, (addrCounts.get(k) ?? 0) + 1)

						addrTotal++
					}
				}

				if (kept.length < CAP) {
					kept.push(e)
				}
			}

			if (!CORPUS_FREQ && kept.length >= CAP) break
		}

		rawBySource.set(spec.source, kept)
		report?.(`    ${spec.source}: ${kept.length} sampled`)
	}

	const addressFrequency = CORPUS_FREQ
		? {
				total: addrTotal,
				distinct: addrCounts.size,
				frequency: (v: string) => (v ? (addrCounts.get(addressFrequencyKey(v)) ?? 0) / addrTotal : 0),
			}
		: undefined

	if (CORPUS_FREQ) {
		report?.(`    address-frequency table: ${addrCounts.size} distinct over ${addrTotal} ${STATE} addresses`)
	}

	report?.("[B] building the geocoder…")
	const geocoder = await options.createGeocoder()

	let geo = 0
	let total = 0

	const geocodeForIngest: GeocodeAddress = async (raw) => {
		const g = await geocoder.geocodeAddress(raw)

		total++

		if (g?.geocode) {
			geo++
		}

		return g
	}

	report?.("[C] geocoding + ingesting all sources…")
	const records: SourceRecord[] = []

	for (const spec of SPECS) {
		const rows = rawBySource.get(spec.source)!

		const g0 = geo
		const t0 = total
		const recs = await ingestRows(rows, spec.mapping, { geocodeAddress: geocodeForIngest })
		const dg = geo - g0
		const dt = total - t0
		report?.(`    ${spec.source}: geocoded ${dg}/${dt} (${dt ? ((100 * dg) / dt).toFixed(1) : "0"}%)`)

		for (const r of recs) {
			r.id = `${spec.source}:${r.id}`
		}

		records.push(...recs)
	}

	geocoder[Symbol.dispose]()
	report?.(`    ${records.length} records; geocoded ${geo}/${total} (${((100 * geo) / total).toFixed(1)}%)`)

	report?.("[D] resolving across sources…")

	const { entities, candidatePairs } = resolveEntities(records, {
		trainEM: true,
		learnedScorer: false,
		...(addressFrequency ? { addressFrequency } : {}),
	})

	const sourceOf = (r: SourceRecord) => r.source ?? "?"

	const crossSource = entities
		.map((e) => ({ e, sources: new Set(e.records.map(sourceOf)) }))
		.filter((x) => x.sources.size >= 2)
		.toSorted((a, b) => b.sources.size - a.sources.size || b.e.records.length - a.e.records.length)

	const pairCounts = new Map<string, number>()

	for (const { sources } of crossSource) {
		const list = [...sources].toSorted()

		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const k = `${list[i]} ↔ ${list[j]}`
				pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
			}
		}
	}

	const lines: string[] = [
		`# Cross-dataset correlation (#618 / #87 real-data run)`,
		"",
		`_Generated by \`mailwoman registry scorer-eval cross-dataset\`. ${STATE}-scoped, ≤${CAP} rows per ` +
			`source geocoded, resolved BLIND across sources (geo-first block → Fellegi-Sunter + EM → cluster) with the ` +
			`proven changes default-on (#86). The sources share no key; an entity spanning ≥2 sources is a cross-dataset ` +
			`link we surface for review — interpretation is the consumer's._`,
		"",
		`## Sources`,
		"",
	]

	const blurb: Record<string, string> = {
		"txhhsc-nursing": "TX HHSC licensed nursing facilities",
		"fcc-rhc": "FCC Rural Health Care posted-services filings",
		"fcc-rhc-commitments": "FCC RHC funding commitments (Filing + Participating HCP, exploded)",
		nppes: "NPPES organization NPIs",
	}

	lines.push(`| source | rows | what it is |`)
	lines.push(`|---|---:|---|`)

	for (const spec of SPECS) {
		lines.push(`| \`${spec.source}\` | ${rawBySource.get(spec.source)!.length} | ${blurb[spec.source] ?? ""} |`)
	}

	lines.push("")

	lines.push(
		`Combined: **${records.length} records**, geocoded ${pct(geo / total)}%. Resolved to ` +
			`**${entities.length} entities** from ${candidatePairs} candidate pairs.`
	)

	lines.push("")

	lines.push(
		addressFrequency
			? `Matched with the proven changes default-on (#86): collapsed spatial (A1) + inverse-address-frequency, fed ` +
					`a corpus-wide table built from the full source files (**${addressFrequency.distinct.toLocaleString()}** distinct ` +
					`addresses over **${addressFrequency.total.toLocaleString()}** ${STATE} rows — a crowded shared campus is ` +
					`down-weighted as weak identity evidence).`
			: `Matched with the zero-config default (#86): collapsed spatial (A1) + an input-scoped address-frequency table ` +
					`(\`--no-corpus-frequency\`; pass nothing to build the corpus-wide table from the full files instead).`
	)

	lines.push("")

	lines.push(
		`Scored with the Fellegi-Sunter baseline (\`learnedScorer: false\`): cross-dataset link discovery is ` +
			`recall-oriented — the same facility under different operational names across sources is the signal — so the ` +
			`dedup-calibrated GBT default (#603), which is trained to REJECT "same place, different name," is pinned off ` +
			`here. A cross-objective GBT threshold is the follow-up (#655).`
	)

	lines.push("")
	lines.push(`## Cross-dataset links (entities spanning ≥2 sources)`)
	lines.push("")
	lines.push(`**${crossSource.length}** entities resolve across ≥2 sources.`)
	lines.push("")

	if (pairCounts.size) {
		lines.push(`| source pair | entities linked |`)
		lines.push(`|---|---:|`)

		for (const [k, v] of [...pairCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
			lines.push(`| ${k} | ${v} |`)
		}

		lines.push("")
	}

	const triple = crossSource.filter((x) => x.sources.size >= MIN_TRIPLE_SOURCES).length

	if (triple) {
		lines.push(`Of those, **${triple}** span all three sources.`)
	}

	lines.push("")
	lines.push(`## Spot-check — the first 12 cross-source entities (verify by eye)`)
	lines.push("")
	lines.push(`| entity | sources | name (representative) | coordinate |`)
	lines.push(`|---|---|---|---|`)

	for (const { e, sources } of crossSource.slice(0, 12)) {
		const coord = e.coordinate ? `${e.coordinate.latitude.toFixed(4)}, ${e.coordinate.longitude.toFixed(4)}` : "—"
		lines.push(`| ${e.id} | ${[...sources].toSorted().join(", ")} | ${repName(e)} | ${coord} |`)
	}

	lines.push("")
	lines.push(`## Reading`)
	lines.push("")

	lines.push(
		`${SPECS.length} datasets with no shared key — a provider registry, a federal funding program (two of its forms, ` +
			`the commitments form exploded into its Filing + Participating HCP per row), and a state facility registry — ` +
			`resolve into a single entity model where ${crossSource.length} entities are corroborated by ≥2 independent ` +
			`sources (${triple} by all three kinds), purely on geocoded location + name/org agreement, in pure Node without ` +
			`Elasticsearch or a server. Each cross-source entity is a candidate "same place, multiple records" surfaced for ` +
			`review; whether a correlation means anything is the data consumer's call, not ours.`
	)

	lines.push("")

	const md = lines.join("\n")

	console.log(md)

	if (OUT_MD) {
		await writeLocalFile(md, OUT_MD)
		report?.(`\n[written] ${OUT_MD}`)
	}

	if (OUT_GEOJSON) {
		const fc = toGeoJSON(entities)
		await writeLocalJSONFile(fc, OUT_GEOJSON)
		report?.(`[written] ${OUT_GEOJSON} — ${fc.features.length} entity features (${crossSource.length} cross-source)`)
	}

	return { markdown: md }
}
