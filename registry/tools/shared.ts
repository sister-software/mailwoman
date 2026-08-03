/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared helpers for the `registry/tools` probe battery.
 *
 *   The rule: anything reused by two or more probes belongs here; anything a single probe needs
 *   stays with that probe.
 */

import type { ColumnMapping } from "../ingest.ts"

export interface SourceSpec {
	source: string
	path: string
	mapping: ColumnMapping
	inState: (row: Record<string, string>) => boolean
}

/**
 * Trim, treating `undefined` as empty — the shape every probe's raw CSV columns arrive in.
 */
export const norm = (s: string | undefined): string => (s ?? "").trim()

/**
 * Join the four US address columns into one line, dropping blanks.
 */
export const addr = (line: string, city: string, st: string, zip: string): string =>
	[norm(line), norm(city), norm(st), norm(zip)].filter(Boolean).join(", ")

/**
 * Arithmetic mean; `0` on an empty sample rather than `NaN`, because these feed report tables that print a number per
 * row.
 */
export const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)

/**
 * Logistic function with the input clamped to +/-30 — past that `Math.exp` underflows to 0 and the gradient step
 * silently becomes a no-op.
 */
export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

/**
 * `n + 1` evenly-spaced order statistics of an already-sorted sample, de-duplicated — the candidate split thresholds a
 * GBT node considers. `[0]` for an empty sample so a degenerate feature still yields one (useless but well-formed)
 * threshold rather than an empty split set.
 */
export function uniqueQuantiles(sorted: readonly number[], n: number): number[] {
	if (!sorted.length) return [0]
	const ts = new Set<number>()

	for (let k = 0; k <= n; k++) {
		ts.add(sorted[Math.floor((k / n) * (sorted.length - 1))]!)
	}

	return [...ts]
}

/**
 * The TX facility source specs two probes reconcile against each other. `cross-dataset-correlation` deliberately keeps
 * its own longer list — it correlates a wider set than these two reconcile.
 */
export const buildSpecs = (S: string, STATE: string): SourceSpec[] => [
	{
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
		inState: (r) =>
			norm(r["Provider Business Practice Location Address State Name"]).toUpperCase() === STATE &&
			norm(r["Entity Type Code"]) === "2" &&
			!!norm(r["Provider Organization Name (Legal Business Name)"]),
	},
]
