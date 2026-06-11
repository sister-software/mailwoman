/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Overture Maps addresses-theme ingest + per-country fill-rate probe (#471, epic #470).
 *
 *   Pulls address rows for a pinned Overture release into per-country local Parquet via DuckDB with
 *   predicate pushdown (megabytes per country — never the planet), and emits the fill-rate report
 *   that gates every downstream Overture issue (#472-#477): per-country row counts, field fill
 *   percentages, observed source datasets, and OpenAddresses-lineage share.
 *
 *   Standing rules encoded here (see epic #470 "pre-registered decision rules"):
 *
 *   - The release version is pinned in every artifact path. The addresses theme is ALPHA; rows churn
 *       between monthly releases. Two releases never mix in one artifact.
 *   - The per-row `sources` array is preserved verbatim — it is what makes leakage-free eval filtering
 *       possible (#472) and satisfies the provenance-per-row rule.
 *   - Overture's `id` (GERS) rides along as a nullable passthrough column. Nothing joins on it.
 *
 *   Usage: node --experimental-strip-types scripts/ingest-overture-addresses.ts\
 *   --release 2026-05-20.0 --countries LI,DE,FR [--limit 1000] [--probe-only]\
 *   [--out /mnt/playpen/mailwoman-data/overture]
 *
 *   The probe (fill-rates.json + fill-rates.md) runs against the LOCAL Parquet after ingest, so it is
 *   exact for what we materialized and costs no second remote scan.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseArgs } from "node:util"

import { DuckDBInstance } from "@duckdb/node-api"

const DEFAULT_RELEASE = "2026-05-20.0"
const DEFAULT_OUT_ROOT = "/mnt/playpen/mailwoman-data/overture"
const S3_GLOB = (release: string) =>
	`s3://overturemaps-us-west-2/release/${release}/theme=addresses/type=address/*.parquet`

/** Fields whose fill rate the report tracks — the gate inputs for #472-#477. */
const FILL_FIELDS = ["postcode", "street", "number", "unit", "postal_city"] as const

interface CountryProbe {
	country: string
	rows: number
	fill_pct: Record<string, number>
	address_levels_pct: number
	datasets: Record<string, number>
	oa_lineage_pct: number
}

const { values: args } = parseArgs({
	options: {
		release: { type: "string", default: DEFAULT_RELEASE },
		countries: { type: "string" },
		limit: { type: "string" },
		out: { type: "string", default: DEFAULT_OUT_ROOT },
		"probe-only": { type: "boolean", default: false },
	},
})

if (!args.countries) {
	console.error("--countries is required (ISO 3166-1 alpha-2, comma-separated, e.g. US,DE,FR)")
	process.exit(1)
}

const release = args.release!
const countries = args.countries.split(",").map((c) => c.trim().toUpperCase())
const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined
const outDir = path.join(args.out!, release)
mkdirSync(outDir, { recursive: true })

const instance = await DuckDBInstance.create()
const db = await instance.connect()

// Anonymous access to the public Overture bucket — region only, no credentials.
await db.run("INSTALL httpfs; LOAD httpfs;")
await db.run("INSTALL spatial; LOAD spatial;")
await db.run("SET s3_region='us-west-2';")

const countryParquet = (cc: string) => path.join(outDir, `addresses-${cc.toLowerCase()}.parquet`)

/**
 * Materialize one country into local Parquet. Column set preserves the Overture schema verbatim
 * (nested `sources` + `address_levels` included) plus lon/lat decoded from the WKB point via the
 * spatial extension.
 */
async function ingestCountry(cc: string): Promise<void> {
	const limitClause = limit ? `LIMIT ${limit}` : ""
	const dest = countryParquet(cc)
	const started = Date.now()
	await db.run(`
		COPY (
			SELECT
				id,
				country,
				postcode,
				street,
				number,
				unit,
				address_levels,
				postal_city,
				sources,
				version,
				ST_X(geometry) AS lon,
				ST_Y(geometry) AS lat
			FROM read_parquet('${S3_GLOB(release)}', hive_partitioning = 1)
			WHERE country = '${cc}'
			${limitClause}
		) TO '${dest}' (FORMAT PARQUET, COMPRESSION SNAPPY)
	`)
	const secs = ((Date.now() - started) / 1000).toFixed(0)
	console.log(`[ingest] ${cc} -> ${dest} (${secs}s)`)
}

/** Probe one country's LOCAL Parquet for the fill-rate report. */
async function probeCountry(cc: string): Promise<CountryProbe | null> {
	const src = countryParquet(cc)
	const fillExprs = FILL_FIELDS.map(
		(f) => `round(100.0 * count(nullif(trim(${f}), '')) / count(*), 1) AS ${f}_pct`
	).join(",\n\t\t\t")

	const totals = await db.runAndReadAll(`
		SELECT
			count(*)::BIGINT AS rows,
			${fillExprs},
			round(100.0 * count(*) FILTER (len(address_levels) > 0) / count(*), 1) AS address_levels_pct,
			round(100.0 * count(*) FILTER (
				len(list_filter(sources, s -> s.dataset ILIKE '%openaddress%')) > 0
			) / count(*), 1) AS oa_lineage_pct
		FROM read_parquet('${src}')
	`)
	const row = totals.getRowObjects()[0] as Record<string, unknown>
	if (!row || Number(row.rows) === 0) return null

	const datasetRows = await db.runAndReadAll(`
		SELECT u.dataset AS dataset, count(*)::BIGINT AS n
		FROM (SELECT unnest(sources) AS u FROM read_parquet('${src}'))
		GROUP BY 1 ORDER BY n DESC
	`)
	const datasets: Record<string, number> = {}
	for (const d of datasetRows.getRowObjects() as { dataset: string; n: bigint }[]) {
		datasets[d.dataset ?? "(null)"] = Number(d.n)
	}

	const fill_pct: Record<string, number> = {}
	for (const f of FILL_FIELDS) fill_pct[f] = Number(row[`${f}_pct`])

	return {
		country: cc,
		rows: Number(row.rows),
		fill_pct,
		address_levels_pct: Number(row.address_levels_pct),
		datasets,
		oa_lineage_pct: Number(row.oa_lineage_pct),
	}
}

function renderMarkdown(probes: CountryProbe[]): string {
	const lines = [
		`# Overture addresses fill-rate report — release ${release}`,
		"",
		`Generated by \`scripts/ingest-overture-addresses.ts\` (#471). Gate rule (epic #470): no`,
		`downstream issue proceeds on a country whose relevant field fills <80% without a note.`,
		"",
		"| country | rows | postcode | street | number | unit | postal_city | address_levels | OA-lineage |",
		"| --- | --: | --: | --: | --: | --: | --: | --: | --: |",
	]
	for (const p of probes) {
		lines.push(
			`| ${p.country} | ${p.rows.toLocaleString("en-US")} | ${p.fill_pct.postcode}% | ${p.fill_pct.street}% | ` +
				`${p.fill_pct.number}% | ${p.fill_pct.unit}% | ${p.fill_pct.postal_city}% | ` +
				`${p.address_levels_pct}% | ${p.oa_lineage_pct}% |`
		)
	}
	lines.push("", "## Observed source datasets (per country)", "")
	for (const p of probes) {
		lines.push(`### ${p.country}`, "")
		for (const [ds, n] of Object.entries(p.datasets)) {
			lines.push(`- \`${ds}\` — ${n.toLocaleString("en-US")} rows`)
		}
		lines.push("")
	}
	return lines.join("\n")
}

const probes: CountryProbe[] = []
for (const cc of countries) {
	if (!args["probe-only"]) await ingestCountry(cc)
	const probe = await probeCountry(cc)
	if (probe) {
		probes.push(probe)
		console.log(
			`[probe] ${cc}: ${probe.rows} rows · postcode ${probe.fill_pct.postcode}% · ` +
				`postal_city ${probe.fill_pct.postal_city}% · OA-lineage ${probe.oa_lineage_pct}%`
		)
	} else {
		console.warn(`[probe] ${cc}: no rows found — check the country code or release`)
	}
}

writeFileSync(path.join(outDir, "fill-rates.json"), JSON.stringify({ release, probes }, null, "\t"))
writeFileSync(path.join(outDir, "fill-rates.md"), renderMarkdown(probes))
console.log(`[done] report -> ${path.join(outDir, "fill-rates.{json,md}")}`)

db.closeSync()
