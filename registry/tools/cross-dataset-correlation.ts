/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cross-dataset correlation (#618) — the marquee proof: resolve ONE record set across datasets that
 *   share NO key. NPPES (the national provider registry), FCC Rural Health Care filings, and TX
 *   HHSC facility registries each describe overlapping physical entities under different names,
 *   formats, and schemas. Geo-first blocking is what makes resolving them tractable.
 *
 *   We ingest each source under its own {@link ColumnMapping} + a `source` provenance label into ONE
 *   combined record set, geocode every address through mailwoman's real parser + resolver, resolve
 *   to canonical entities, and report the entities whose members span ≥2 sources — those are the
 *   cross-dataset links. We surface the correlation; interpretation is the consumer's.
 *
 *   Tractable cut: TX-scoped, capped per source. Streams the 4.8 GB NPPES registry via `streamRows`.
 *
 *   Run: `mailwoman registry scorer-eval cross-dataset [--cap 300] [--wof <admin.db>]
 *   [--data-root <dir>] [--out-md docs/articles/evals/<date>-...md]`
 */

import { writeFileSync } from "node:fs"

import { dataRootPath } from "@mailwoman/core/utils"
import {
	addressFrequencyKey,
	ingestRows,
	resolveEntities,
	streamRows,
	toGeoJSON,
	type ColumnMapping,
	type GeocodeAddress,
	type ResolvedEntity,
	type SourceRecord,
} from "@mailwoman/registry"

import type { EvalGeocoderFactory } from "./eval-geocoder.ts"

/** Options for {@linkcode crossDatasetCorrelation}. */
export interface CrossDatasetCorrelationOptions {
	/** The injected geocoder factory (the command wires `mailwoman/geocode-core`; see `./eval-geocoder.ts`). */
	createGeocoder: EvalGeocoderFactory
	/** Record-matcher sources directory. Default `$MAILWOMAN_DATA_ROOT/record-matcher/sources`. */
	sources?: string
	/** Rows kept per source for geocoding (state-scoped). Default 300. */
	cap?: number
	/** State filter. Default TX. */
	state?: string
	/**
	 * The inverse-address-frequency lever is a CORPUS statistic — it can't be synthesized from the geocoded sample. By
	 * default we scan the FULL files (cheap, parse-free) for an in-state corpus-wide frequency table and feed it to the
	 * matcher, so the proven #617 lever actually bites on a sub-sampled run. The scan adds a full pass over the 4.8 GB
	 * NPPES file (~5 min); `--no-corpus-frequency` skips it and falls back to resolveEntities' zero-config input-scoped
	 * default (#86). Default true.
	 */
	corpusFrequency?: boolean
	/** Also write the markdown report here. */
	outMd?: string
	/** Also write the entity FeatureCollection here (the reconciliation artifact, QGIS-ready). */
	outGeojson?: string
}

const norm = (s: string | undefined) => (s ?? "").trim()

/**
 * Compose a row's address the SAME way {@link ingestRows} does (`pick`: join the mapped columns with a space, drop
 * empties), so a frequency key built here matches the geocoded record's `address.raw`.
 */
function composeAddress(row: Record<string, string>, columns: string | string[] | undefined): string {
	if (!columns) return ""
	const list = Array.isArray(columns) ? columns : [columns]

	return list
		.map((c) => norm(row[c]))
		.filter(Boolean)
		.join(" ")
		.trim()
}

/**
 * One source to ingest: where it lives, the column mapping, a TX filter, and an optional row "explode" for files that
 * carry two addressable entities per row (the FCC commitments Filing + Participating HCP).
 */
interface SourceSpec {
	source: string
	path: string
	mapping: ColumnMapping
	/** Keep only rows in-state (reads the row's state column). */
	inState: (row: Record<string, string>) => boolean
	/** Optional: a row carries ≥1 addressable entity — yield each as its own row. Default identity. */
	explode?: (row: Record<string, string>) => Record<string, string>[]
}

const buildSpecs = (S: string, STATE: string): SourceSpec[] => [
	{
		// TX HHSC nursing facilities — facility name + physical address + a real coordinate.
		source: "txhhsc-nursing",
		path: `${S}/txhhsc_nursing-facilities_20260611.tsv`,
		mapping: {
			id: "Facility ID",
			organization: "Facility Name",
			address: ["Physical Address", "Physical Address CITY", "Physical Address State", "Physical Address Zipcode"],
			phone: "Facility Phone Number",
			source: "txhhsc-nursing",
		},
		inState: (r) => norm(r["Physical Address State"]).toUpperCase() === STATE,
	},
	{
		// FCC Rural Health Care posted services — the funding/enrollment side; HCP name + site address.
		source: "fcc-rhc",
		path: `${S}/fcc-rhc_posted-services_form461-465_20260615.tsv`,
		mapping: {
			id: "HCP Number",
			organization: "HCP Name",
			address: ["Site Address Line 1", "Site City", "Site State", "Site ZIP Code"],
			phone: "Contact Phone",
			email: "Contact E-mail",
			source: "fcc-rhc",
		},
		inState: (r) => norm(r["Site State"]).toUpperCase() === STATE,
	},
	{
		// NPPES — organization NPIs (the eligibility side); legal business name + practice address.
		source: "nppes",
		path: `${S}/nppes_npi-registry_20260607.tsv`,
		mapping: {
			id: "NPI",
			organization: "Provider Organization Name (Legal Business Name)",
			address: [
				"Provider First Line Business Practice Location Address",
				"Provider Business Practice Location Address City Name",
				"Provider Business Practice Location Address State Name",
				"Provider Business Practice Location Address Postal Code",
			],
			phone: "Provider Business Practice Location Address Telephone Number",
			source: "nppes",
		},
		// Org-type NPIs in TX with a business name — the entities most likely to co-occur with facilities.
		inState: (r) =>
			norm(r["Provider Business Practice Location Address State Name"]).toUpperCase() === STATE &&
			norm(r["Entity Type Code"]) === "2" &&
			!!norm(r["Provider Organization Name (Legal Business Name)"]),
	},
	{
		// FCC RHC funding commitments — TWO addressable entities per row (a Filing HCP and a Participating
		// HCP). Explode each in-state HCP into its own record (the #618 B1 two-entity-per-row case).
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
	},
]

/** Cross-dataset correlation (#618) — see the module doc. Emits the markdown report to stdout. */
export async function crossDatasetCorrelation(
	options: CrossDatasetCorrelationOptions,
	report?: (line: string) => void
): Promise<{ markdown: string }> {
	const SOURCES = options.sources || dataRootPath("record-matcher", "sources")
	const CAP = options.cap ?? 300 // rows kept per source for geocoding (state-scoped)
	const STATE = (options.state || "TX").toUpperCase()
	const OUT_MD = options.outMd || ""
	const OUT_GEOJSON = options.outGeojson || "" // the reconciliation artifact (FeatureCollection, QGIS-ready)
	const CORPUS_FREQ = options.corpusFrequency ?? true
	const SPECS = buildSpecs(`${SOURCES}`, STATE)

	// --- Phase A: stream each source, TX-filter, explode → keep the first CAP rows for geocoding AND
	// (when --corpus-frequency, the default) count EVERY in-state address into a corpus-wide table. The
	// sample is the matched set; the frequency table reflects the full TX population, so the proven
	// inverse-frequency lever down-weights a genuinely-crowded shared campus even when it appears once in
	// the geocoded sample. ---
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

			// Stop early only when we DON'T need the full frequency pass (otherwise scan to EOF).
			if (!CORPUS_FREQ && kept.length >= CAP) break
		}
		rawBySource.set(spec.source, kept)
		report?.(`    ${spec.source}: ${kept.length} sampled`)
	}
	// The in-state corpus-wide address-frequency table (the #617 lever, fed to the matcher below).
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

	// --- Phase B: geocoder (injected — see ./eval-geocoder.ts). ---
	report?.("[B] building the geocoder…")
	const geocoder = await options.createGeocoder()

	let geo = 0
	let total = 0
	// Count placements at the seam (parity with the retired in-script counter).
	const seam: GeocodeAddress = async (raw) => {
		const g = await geocoder.seam(raw)
		total++

		if (g?.geocode) {
			geo++
		}

		return g
	}

	// --- Phase C: ingest each source (its own mapping + source label) into one combined record set. ---
	report?.("[C] geocoding + ingesting all sources…")
	const records: SourceRecord[] = []

	for (const spec of SPECS) {
		const rows = rawBySource.get(spec.source)!
		// Per-source geocode-rate snapshot (#694 diagnostic): the seam counters are global, so delta
		// them across each source to see WHERE nulls concentrate in the aggregate run.
		const g0 = geo
		const t0 = total
		const recs = await ingestRows(rows, spec.mapping, { geocodeAddress: seam })
		const dg = geo - g0
		const dt = total - t0
		report?.(`    ${spec.source}: geocoded ${dg}/${dt} (${dt ? ((100 * dg) / dt).toFixed(1) : "0"}%)`)

		// Namespace ids by source so cross-source ids never collide.
		for (const r of recs) {
			r.id = `${spec.source}:${r.id}`
		}
		records.push(...recs)
	}
	geocoder.close()
	report?.(`    ${records.length} records; geocoded ${geo}/${total} (${((100 * geo) / total).toFixed(1)}%)`)

	// --- Phase D: resolve to canonical entities. The proven levers are default-on (#86): collapsed
	// spatial (A1) + inverse-address-frequency. We feed the corpus-wide table when we built one; otherwise
	// resolveEntities auto-computes the input-scoped default. ---
	report?.("[D] resolving across sources…")
	// learnedScorer:false — the GBT default is calibrated for same-dataset DEDUP, where "same address +
	// different name" means distinct co-located providers (reject). CROSS-dataset linkage is the opposite
	// objective: "same address + different name" is the prototypical signal of the SAME facility under a
	// different operational name across sources. The dedup GBT rejects exactly those true cross-source
	// links (measured: cross-source 219→166, triple-source 10→1), so this flow uses the recall-appropriate
	// FS baseline. (A cross-objective GBT threshold is the documented follow-up — #655.)
	const { entities, candidatePairs } = resolveEntities(records, {
		trainEM: true,
		learnedScorer: false,
		...(addressFrequency ? { addressFrequency } : {}),
	})

	// --- Phase E: find the cross-source entities — members spanning ≥2 distinct sources. ---
	const sourceOf = (r: SourceRecord) => r.source ?? "?"
	const crossSource = entities
		.map((e) => ({ e, sources: new Set(e.records.map(sourceOf)) }))
		.filter((x) => x.sources.size >= 2)
		.sort((a, b) => b.sources.size - a.sources.size || b.e.records.length - a.e.records.length)

	// Source-pair co-occurrence matrix.
	const pairCounts = new Map<string, number>()

	for (const { sources } of crossSource) {
		const list = [...sources].sort()

		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const k = `${list[i]} ↔ ${list[j]}`
				pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
			}
		}
	}

	const repName = (e: ResolvedEntity) =>
		e.representative.organization?.canonical ??
		[e.representative.name?.given, e.representative.name?.family].filter(Boolean).join(" ") ??
		e.representative.id

	// --- Report. ---
	// NOTE(phase4): local pct keeps the fraction-in/no-%-suffix shape — not core formatPercent's
	// numerator/denominator contract (call sites append their own "%").
	const pct = (x: number) => (100 * x).toFixed(1)
	const lines: string[] = []
	lines.push(`# Cross-dataset correlation (#618 / #87 real-data run)`)
	lines.push("")
	lines.push(
		`_Generated by \`mailwoman registry scorer-eval cross-dataset\`. ${STATE}-scoped, ≤${CAP} rows per ` +
			`source geocoded, resolved BLIND across sources (geo-first block → Fellegi-Sunter + EM → cluster) with the ` +
			`proven levers default-on (#86). The sources share no key; an entity spanning ≥2 sources is a cross-dataset ` +
			`link we surface for review — interpretation is the consumer's._`
	)
	lines.push("")
	lines.push(`## Sources`)
	lines.push("")
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
			? `Matched with the proven levers default-on (#86): collapsed spatial (A1) + inverse-address-frequency, fed ` +
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

		for (const [k, v] of [...pairCounts.entries()].sort((a, b) => b[1] - a[1])) {
			lines.push(`| ${k} | ${v} |`)
		}
		lines.push("")
	}
	const triple = crossSource.filter((x) => x.sources.size >= 3).length

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
		lines.push(`| ${e.id} | ${[...sources].sort().join(", ")} | ${repName(e)} | ${coord} |`)
	}
	lines.push("")
	lines.push(`## Reading`)
	lines.push("")
	lines.push(
		`${SPECS.length} datasets with no shared key — a provider registry, a federal funding program (two of its forms, ` +
			`the commitments form exploded into its Filing + Participating HCP per row), and a state facility registry — ` +
			`resolve into a single entity model where ${crossSource.length} entities are corroborated by ≥2 independent ` +
			`sources (${triple} by all three kinds), purely on geocoded location + name/org agreement, in pure Node (no ` +
			`Elasticsearch, no server). Each cross-source entity is a candidate "same place, multiple records" surfaced for ` +
			`review; whether a correlation means anything is the data consumer's call, not ours.`
	)
	lines.push("")

	const md = lines.join("\n")
	console.log(md)

	if (OUT_MD) {
		writeFileSync(OUT_MD, md)
		report?.(`\n[written] ${OUT_MD}`)
	}

	// --- The reconciliation artifact: a GeoJSON FeatureCollection of every resolved entity. Each feature
	// carries `sources` + `sourceIds` (so an analyst filters the cross-dataset links by `sources` length ≥ 2)
	// and the geocode tier. QGIS-ready; this is the operator-verifiable output of the matcher. ---
	if (OUT_GEOJSON) {
		const fc = toGeoJSON(entities)
		writeFileSync(OUT_GEOJSON, JSON.stringify(fc, null, 2))
		report?.(`[written] ${OUT_GEOJSON} — ${fc.features.length} entity features (${crossSource.length} cross-source)`)
	}

	return { markdown: md }
}
