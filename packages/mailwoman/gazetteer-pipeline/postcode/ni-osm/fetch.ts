/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Northern Ireland `BT` postcode acquisition from **OpenStreetMap**, via one Overpass query.
 *
 *   This is option (b) of the three `NORTHERN_IRELAND_OPTIONS_NOTE` (in `../codepoint/fetch.ts`) lays
 *   out for the `BT` hole that Code-Point Open leaves and that no OGL source can fill. Option (a) is
 *   licensing LPS Pointer at ~£9,224; option (c) — ship nothing — is what the GB shard does today. (b)
 *   is partial and ODbL, so it lands at the **build-local tier**: this machine builds it, it never
 *   enters an npm tarball, and `DEFAULT_POSTCODE_SHARDS` is `existsSync`-filtered, which IS the
 *   build-local mechanism. Same posture as `poi.db` and `@mailwoman/osm`.
 *
 *   ## Why one query, saved verbatim
 *
 *   Overpass is a volunteer-run public endpoint with a published fair-use policy. The acquisition is a
 *   SINGLE request whose response is written to a dated directory and never re-fetched; every later
 *   build reads that file. So the reproducibility artifact is the response, not the query — a rebuilt
 *   shard from the same `response.json` is byte-comparable, while a re-query against a live OSM would
 *   not be (OSM changes hourly, and that is a feature of the source, not a defect of the build).
 *
 *   ## Why not `@mailwoman/poi-taxonomy`'s emitter
 *
 *   `emitOverpassQL` renders a query from a POI INTENT (a category/brand/name subject plus an anchor).
 *   This query has no subject — it is a bounding box plus a tag regex — so the emitter has nothing to
 *   emit from. The query text is a constant here, which is also what makes it hashable into provenance.
 *
 *   ## Licence
 *
 *   ODbL 1.0, share-alike on a Derived Database. The attribution is mandatory and rides in the shard's
 *   own `meta` table; see {@link OSM_ATTRIBUTION} and {@link NI_OSM_BUILD_LOCAL_NOTE}.
 */

import { mkdir, stat, writeFile } from "node:fs/promises"

import { APIClient } from "@mailwoman/core/api"
import { md5File, md5Hex } from "@mailwoman/core/utils"
import { join } from "path-ts"

/**
 * The public Overpass API endpoint. Volunteer-run; see https://operations.osmfoundation.org/policies/api/ — the
 * acquisition makes exactly one request against it.
 */
export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"

/**
 * The Kumi Systems mirror, recorded as a CHECKED NEGATIVE rather than as a fallback.
 *
 * It is the mirror the OSM wiki points at for heavy queries, so it is the obvious thing to reach for when the main
 * instance 504s — and on 2026-08-05 it was the wrong move. Three of three attempts returned HTTP 504: the whole-NI area
 * query at 97 s, the whole-NI bbox query at 115 s, and — decisively — a two-tenths-of-a-degree probe bbox at 95 s that
 * `overpass-api.de` answered 200 in 8 s from the same machine minutes later. A mirror that cannot serve an 8-second
 * query is an unhealthy host, not a capacity answer. Pass it via {@link AcquireNIPostcodesOptions.endpoint} if it
 * recovers; do not promote it to default on the strength of the wiki page.
 */
export const OVERPASS_ENDPOINT_KUMI = "https://overpass.kumi.systems/api/interpreter"

/**
 * The one query. Verbatim, because its md5 goes into the shard's provenance and a reader must be able to re-run exactly
 * this text.
 *
 * ## The spatial filter is a BBOX, not `area["ISO3166-2"="GB-NIR"]`
 *
 * The area form — `area["ISO3166-2"="GB-NIR"]->.ni; nwr(area.ni)["addr:postcode"~"^BT"];` — is the obvious way to write
 * this, and both attempts at it on 2026-08-05 ended in an HTTP 504 from `overpass-api.de`'s gateway. An `(area)` filter
 * has no index to ride: Overpass enumerates the region's elements and tests each, so the whole of Northern Ireland is a
 * full scan. The bbox rides the spatial index instead, and the same instance answered THIS query 200 with 6,681,108
 * bytes in 36 s.
 *
 * Be careful how much that proves. Over the same fifteen-minute window `overpass-api.de` returned 504 for the bbox form
 * too (once, at 7 s) while answering an identical curl seconds earlier, and later returned 429 — the instance was
 * flapping, so the area form is not PROVEN too expensive, only observed to fail twice. The bbox form is preferred on
 * two independent grounds regardless: it is index-backed, and re-issuing a whole-region scan against a flaking
 * volunteer endpoint is the wrong kind of retry.
 *
 * The bbox loses nothing, because **`BT` is a Northern Ireland-exclusive postcode area** — the tag filter is already
 * the NI selector, and the bbox exists only to make it index-cheap. The corners are a deliberate superset of NI: a
 * tight box could clip a border townland, and a `BT` postcode on the Republic side of the line is still a `BT`
 * postcode, which is exactly the fact this shard attests.
 *
 * ## The rest
 *
 * `nwr` takes nodes, ways AND relations, because OSM carries `addr:postcode` on standalone address nodes and on
 * building polygons alike; `out center;` collapses each way/relation to its centroid so every element arrives as one
 * point.
 *
 * The tag filter is `~"^BT"` — CASE-SENSITIVE, which is Overpass's default for `~`. A lowercase `bt3 9qq` in OSM is
 * therefore invisible to this query. That is deliberate: it is the filter the 2026-08-05 census was taken with, so the
 * build's numbers reconcile against that census rather than against a different population.
 */
export const NI_POSTCODE_OVERPASS_QUERY = [
	"[out:json][timeout:300];",
	'nwr["addr:postcode"~"^BT"](53.95,-8.30,55.40,-5.30);',
	"out center;",
].join("\n")

/**
 * The licence every byte of this acquisition carries.
 */
export const OSM_LICENSE = "Open Database License (ODbL) 1.0"

/**
 * The ODbL deed.
 */
export const OSM_LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

/**
 * The attribution OSM requires of anyone redistributing its data or a work produced from it. Not optional, and not
 * satisfied by a link in a README — it rides in the artifact.
 */
export const OSM_ATTRIBUTION =
	"© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0 " +
	"(https://opendatacommons.org/licenses/odbl/1-0/); see https://www.openstreetmap.org/copyright."

/**
 * Why this shard is BUILD-LOCAL, in one sentence plus the receipts.
 *
 * ODbL §4.4 makes a Derived Database share-alike: publish one and you must publish it under ODbL. Mailwoman's shipped
 * gazetteer is assembled from permissive sources (WOF, Overture, OpenAddresses, GeoNames, Code-Point Open) precisely so
 * that no consumer inherits a share-alike obligation from installing an npm package. Folding OSM-derived rows into a
 * SHIPPED shard would push that obligation onto every consumer of `mailwoman`, which is the outcome the whole
 * permissive sourcing discipline exists to avoid.
 *
 * So the artifact stays on the machine that builds it. The enforcement is not a policy document:
 * `DEFAULT_POSTCODE_SHARDS` is resolved through `existsSync`, and nothing copies this file into a tarball, an R2
 * bucket, or the demo. An operator who wants NI coverage runs the builder and accepts ODbL on their own artifact — the
 * same opt-in-per-country posture `@mailwoman/osm` already documents, and the same tier `poi.db` sits in.
 */
export const NI_OSM_BUILD_LOCAL_NOTE =
	"BUILD-LOCAL TIER — this artifact is never published. OSM data is ODbL 1.0, whose share-alike clause (§4.4) binds a " +
	"Derived Database, and every shipped mailwoman gazetteer artifact is built from permissive sources specifically so " +
	"that installing the package imposes no share-alike obligation on a consumer. This shard is therefore built on the " +
	"operator's own machine, is excluded from every npm tarball / R2 publish / demo asset, and is picked up at runtime " +
	"only because `DEFAULT_POSTCODE_SHARDS` is existsSync-filtered. An operator who builds it takes the ODbL obligation " +
	"on their own copy. Same posture as @mailwoman/osm's address-point shards and the poi.db layer."

/**
 * One element as Overpass returns it under `out center`.
 */
export interface OverpassElement {
	type: string
	id: number
	/**
	 * Present on nodes.
	 */
	lat?: number
	lon?: number
	/**
	 * Present on ways/relations under `out center` — the geometry's centre.
	 */
	center?: { lat: number; lon: number }
	tags?: Record<string, string>
}

/**
 * The Overpass JSON envelope. `osm3s.timestamp_osm_base` is the DATA cut this response reflects — a far more useful
 * provenance stamp than the wall clock at retrieval, and it is why the response is kept whole rather than reduced.
 */
export interface OverpassResponse {
	version?: number
	generator?: string
	osm3s?: {
		timestamp_osm_base?: string
		timestamp_areas_base?: string
		copyright?: string
	}
	elements: OverpassElement[]
}

/**
 * Build the Overpass client.
 *
 * `APIClient` per `AGENTS.md`: this is a small-body API request against a rate-limited volunteer host — the exact
 * population the rule binds. `minRequestIntervalMs` is set even though the acquisition issues ONE request, because an
 * unpaced client is a trap for the next caller who loops it. Retry is deliberately OFF (the `APIClient` default): an
 * Overpass 429/504 means the server is shedding load, and the correct response to that is to come back later by hand,
 * not to have a script re-issue a whole-region scan — which is exactly what happened on 2026-08-05, when the instance
 * flapped through five 504s and a 429 before answering. `timeout` is 10 minutes, comfortably past the query's own
 * `[timeout:300]` plus the transfer of a ~7 MB body (measured: 36 s end to end).
 */
export function createOverpassClient(): APIClient {
	return new APIClient({
		displayName: "overpass",
		minRequestIntervalMs: 2000,
		axios: {
			timeout: 600_000,
			headers: {
				// Overpass's fair-use policy asks that clients identify themselves.
				"User-Agent": "mailwoman-gazetteer/1.0 (+https://mailwoman.ai)",
			},
		},
	})
}

export interface AcquireNIPostcodesOptions {
	/**
	 * Directory the response lands in. The convention is a NEW dated directory per acquisition
	 * (`$MAILWOMAN_DATA_ROOT/osm-ni-postcodes/<YYYY-MM-DD>/`), so an acquisition never overwrites an earlier one.
	 */
	destDir: string
	/**
	 * Reuse an existing `response.json` instead of re-querying. The DEFAULT, and it is the point: Overpass is a volunteer
	 * endpoint and the saved response is the reproducibility artifact. Set `false` only to take a deliberate new cut into
	 * a NEW dated directory.
	 */
	reuseExisting?: boolean
	client?: APIClient
	/**
	 * Override the Overpass instance. Default {@link OVERPASS_ENDPOINT}; the endpoint actually used is recorded in
	 * `acquisition.json` and in the shard's `meta`, because which mirror answered is part of the provenance.
	 */
	endpoint?: string
	/**
	 * Retrieval clock, stamped into `acquisition.json`. Passed in so the module never reads the clock implicitly.
	 */
	now?: Date
	onPhase?: (phase: string, detail?: string) => void
}

export interface AcquireNIPostcodesResult {
	/**
	 * Absolute path of the saved response — the ONLY file the builder reads.
	 */
	responsePath: string
	/**
	 * Absolute path of the retrieval-metadata sidecar.
	 */
	acquisitionPath: string
	bytes: number
	/**
	 * Md5 of the response bytes on disk.
	 */
	md5: string
	/**
	 * Md5 of {@link NI_POSTCODE_OVERPASS_QUERY} — the query fingerprint that travels into the shard's `meta`.
	 */
	queryMD5: string
	/**
	 * The Overpass instance that answered.
	 */
	endpoint: string
	/**
	 * True when the bytes were already on disk, so no request was made.
	 */
	reused: boolean
}

/**
 * Fingerprint of the query text. Exported so the builder can record it without re-hashing prose.
 */
export function niPostcodeQueryMD5(): string {
	return md5Hex(NI_POSTCODE_OVERPASS_QUERY)
}

/**
 * Run the one Overpass query and save its response verbatim to `<destDir>/response.json`, with an `.md5` sidecar and an
 * `acquisition.json` recording endpoint, query text, query md5 and retrieval time.
 *
 * The response is taken as an `arraybuffer` and written unmodified — no parse, no re-serialize. A JSON round-trip would
 * silently renormalize number formatting and key order, and then the md5 in the provenance would describe bytes nobody
 * can reproduce.
 */
export async function acquireNIPostcodes(options: AcquireNIPostcodesOptions): Promise<AcquireNIPostcodesResult> {
	const { destDir, reuseExisting = true, endpoint = OVERPASS_ENDPOINT } = options
	const phase = options.onPhase ?? (() => {})
	const now = options.now ?? new Date()
	const responsePath = String(join(destDir, "response.json"))
	const acquisitionPath = String(join(destDir, "acquisition.json"))
	const queryMD5 = niPostcodeQueryMD5()

	await mkdir(destDir, { recursive: true })

	if (reuseExisting) {
		const existing = await md5File(responsePath).catch(() => null)

		if (existing) {
			phase("reuse", `${responsePath} already present (md5 ${existing})`)
			const stats = await stat(responsePath)

			// A response with no sidecar beside it is provenance-less, and an operator who copied only the
			// bytes into place should not get a shard that says "unknown". Reconstruct what is recoverable
			// and SAY that it was reconstructed: the retrieval instant becomes the file's mtime, which is
			// when those bytes were written, and the flag keeps that distinguishable from a first-hand
			// stamp. (The meaning-of-zero rule in its provenance form — a recovered value and a recorded
			// one are different claims and must not read alike.)
			if (!(await stat(acquisitionPath).catch(() => null))) {
				phase("sidecar", "acquisition.json missing — reconstructing from the response file's mtime")

				await writeAcquisitionSidecar(acquisitionPath, {
					endpoint,
					queryMD5,
					retrievedAt: stats.mtime.toISOString(),
					bytes: stats.size,
					md5: existing,
					reconstructed: true,
				})
			}

			return { responsePath, acquisitionPath, bytes: stats.size, md5: existing, queryMD5, endpoint, reused: true }
		}
	}

	const client = options.client ?? createOverpassClient()

	phase("query", `${endpoint} (one request; query md5 ${queryMD5})`)

	const response = await client.fetch<ArrayBuffer>({
		url: endpoint,
		method: "POST",
		// Overpass takes the query as a form field named `data`.
		data: new URLSearchParams({ data: NI_POSTCODE_OVERPASS_QUERY }).toString(),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		responseType: "arraybuffer",
		// The dated directory IS the cache; a second response body in the disk cache would only be a
		// second copy that can drift from the artifact the builder reads.
		cache: false,
	} as Parameters<APIClient["fetch"]>[0])

	const body = Buffer.from(response.data)
	await writeFile(responsePath, body)
	const md5 = await md5File(responsePath)

	phase("saved", `${body.byteLength.toLocaleString()} bytes → ${responsePath} (md5 ${md5})`)

	await writeFile(`${responsePath}.md5`, `${md5}  response.json\n`, "utf8")

	await writeAcquisitionSidecar(acquisitionPath, {
		endpoint,
		queryMD5,
		retrievedAt: now.toISOString(),
		bytes: body.byteLength,
		md5,
	})

	return { responsePath, acquisitionPath, bytes: body.byteLength, md5, queryMD5, endpoint, reused: false }
}

/**
 * The retrieval-metadata sidecar, as it lands on disk beside the response.
 */
export interface NIAcquisitionSidecar {
	endpoint: string
	query: string
	queryMD5: string
	retrievedAt: string
	bytes: number
	md5: string
	license: string
	licenseURL: string
	attribution: string
	tier: string
	/**
	 * Present and `true` only when the sidecar was rebuilt from a response file found already on disk — so its
	 * `retrievedAt` is the file's mtime rather than an observed request time. Absent means first-hand.
	 */
	reconstructed?: boolean
}

/**
 * Write `acquisition.json`. The licence block is written here rather than assembled by the caller so that every path
 * that produces a sidecar produces the SAME one — the ODbL attribution is an obligation, and an obligation that depends
 * on which branch wrote the file is an obligation waiting to be missed.
 */
async function writeAcquisitionSidecar(
	path: string,
	input: {
		endpoint: string
		queryMD5: string
		retrievedAt: string
		bytes: number
		md5: string
		reconstructed?: boolean
	}
): Promise<void> {
	const sidecar: NIAcquisitionSidecar = {
		endpoint: input.endpoint,
		query: NI_POSTCODE_OVERPASS_QUERY,
		queryMD5: input.queryMD5,
		retrievedAt: input.retrievedAt,
		bytes: input.bytes,
		md5: input.md5,
		license: OSM_LICENSE,
		licenseURL: OSM_LICENSE_URL,
		attribution: OSM_ATTRIBUTION,
		tier: "build-local",
		...(input.reconstructed ? { reconstructed: true } : {}),
	}

	await writeFile(path, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8")
}
