/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvest ČÚZK's INSPIRE Addresses archives into the directory `#cz/adapters/cuzk/adapter` reads.
 *
 * ČÚZK serves the Addresses (AD) theme as a two-level ATOM service rather than as a WFS. The
 * service document at `https://atom.cuzk.gov.cz/AD/AD.xml` holds one entry per municipality, each
 * pointing at a dataset feed, and each dataset feed offers that municipality's addresses as a
 * zipped GML in two projections. Measured 2026-10-02: the service document answered HTTP 200 with
 * 8,373,817 bytes holding 6,258 entries, sha256
 * `9b1d51a721ab601fa74307cce5ce20f74d12dd29512f87be29cd1072f0a2d83b`.
 *
 * The acquisition belongs under a `tools/` root. `@mailwoman/corpus` is one of the
 * `TOOLING_PACKAGES` in `dependency-cruiser.config.mjs`, which keep their tooling under `lib/`, so
 * this module sits beside `#fr/tools/fetch/ban` rather than in an `sdk/` root the workspace does
 * not declare.
 *
 * Every one of the service document's `rights` elements reads `žádné podmínky neplatí`, INSPIRE's
 * controlled value for no conditions applying to access and use, and the address-source register
 * elects it on that basis. `#cz/adapters/cuzk/adapter` records the same value on every row.
 *
 * Four properties of this service decide the harvest's shape, and each was measured rather than
 * assumed:
 *
 * 1. **The service document carries each municipality's file modification time.** An entry's
 *    `<updated>` equals the archive's `Last-Modified` to the second, checked on six municipalities
 *    on 2026-10-02 — `584061` reads `2026-06-04T02:19:33+02:00` against
 *    `Thu, 04 Jun 2026 00:19:33 GMT`, and `531529`, `551481`, `545031`, `587044` and `584282`
 *    agree the same way. So one 8.4 MB request states the freshness of all 6,258 archives, and a
 *    re-run requests only the municipalities whose stated time moved. The alternative — a
 *    conditional request per municipality — costs 6,258 round trips to learn the same thing.
 * 2. **The download URL is composed from a base the feed itself declares.** The service document's
 *    own `rel="next"` links are `https://services.cuzk.gov.cz/gml/inspire/ad/epsg-4258` and
 *    `…/epsg-5514`, and a dataset feed's `alternate` link for the same municipality is that base
 *    plus `/<code>.zip`. Composing from the declared base rather than reading 6,258 dataset feeds
 *    halves the harvest's requests. {@linkcode HarvestCzCuzkOptions.resolveThroughDatasetFeed}
 *    reads the publisher's own href instead, for a run that will not compose a URL.
 * 3. **The `type` attribute describes the data rather than the file.** A dataset feed's link
 *    advertises `application/gml+xml` while the host serves `application/zip`, so the GML is inside
 *    the archive and the advertised type cannot decide what to write. The archive is stored as it
 *    arrives: the adapter opens it with `adm-zip`, because at least one archive's central directory
 *    records its member's size as the ZIP64 sentinel `0xFFFFFFFF`.
 * 4. **A dataset feed's `length` is accurate here, and is still not used.** `584061.zip` claims
 *    24,846 bytes and the host's `content-length` says 24,846. Denmark's feed understates its file
 *    by 23 times, so every byte count this module records is counted off the delivered body.
 *
 * The archives are small — a systematic sample of 50 of the 6,258 municipalities on 2026-10-02 ran
 * from 5,236 to 1,642,586 bytes with a median of 16,591 — so the harvest is bound by round trips
 * rather than by bandwidth, and it is dispatched serially through one `APIClient`. ČÚZK publishes
 * no rate limit. {@linkcode CZ_CUZK_REQUEST_INTERVAL_MS} holds the harvest to four requests per
 * second against one government host, which is under half of the ten per second the same 50
 * requests measured, and a caller that has asked ČÚZK for more raises it.
 */

/* oxlint-disable sister-software/prefer-region-over-marks -- these markers label steps inside one
   procedure rather than sections of declarations. A region there folds no element a reader wants folded. */

import { APIClient, assertNoOGCServiceException } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { CZ_CUZK_ADAPTER_ID, CZ_CUZK_LICENSE } from "#cz/adapters/cuzk/adapter"
import type { AtomFeed, AtomLink } from "#tools/fetch/atom"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, writeManifest } from "#tools/fetch/download"

/**
 * The ATOM service document listing one dataset feed per municipality.
 */
export const CZ_CUZK_SERVICE_FEED_URL = "https://atom.cuzk.gov.cz/AD/AD.xml"

/**
 * The directory the harvest writes under, which is the adapter's `inputPath`.
 */
const SLUG = CZ_CUZK_ADAPTER_ID

/**
 * The attribution the model card must carry for this source.
 */
export const CZ_CUZK_ATTRIBUTION = "Český úřad zeměměřický a katastrální (ČÚZK), INSPIRE téma Adresy"

/**
 * The two projections the service offers, keyed by the path segment the feed's own base URL ends in.
 *
 * The adapter reads either.
 * `epsg-4258` is ETRS89, in degrees, and is the projection the adapter's
 * component joins were verified against.
 */
export const CZ_CUZK_PROJECTIONS = {
	"epsg-4258": "ETRS89",
	"epsg-5514": "S-JTSK",
} as const

/**
 * One of {@linkcode CZ_CUZK_PROJECTIONS}.
 */
export type CzCuzkProjection = keyof typeof CZ_CUZK_PROJECTIONS

/**
 * The minimum spacing between two requests to `services.cuzk.gov.cz`, in milliseconds.
 *
 * Four requests per second.
 * A systematic sample of 50 archives on 2026-10-02 answered a serial `HEAD` in 100 ms each,
 * so this leaves the host more than half the rate it demonstrated.
 */
export const CZ_CUZK_REQUEST_INTERVAL_MS = 250

/**
 * The first two bytes of every zip archive, `PK`.
 *
 * The check is on the signature rather than on a size, because an error page
 * and a small municipality are told apart by what the body is rather than by
 * how long it is: the smallest archive in the 2026-10-02 sample is 5,236 bytes,
 * and a size floor between the two would be a number fitted to that sample.
 */
const ZIP_SIGNATURE = "PK"

/**
 * How many archives are written between two manifest writes.
 *
 * The manifest is what makes an interrupted harvest resumable, and writing it
 * after every archive would rewrite a 6,258-entry document 6,258 times.
 * At this interval an interruption re-fetches at most this many archives that are already on disk.
 */
const MANIFEST_INTERVAL = 25

/**
 * One municipality's dataset, as the service document states it.
 */
export interface CzMunicipalityDataset {
	/**
	 * The municipality code, which is both the `obec` code and the archive's file name stem.
	 */
	code: string
	/**
	 * The entry's title, `INSPIRE - adresní místa - obec: Unkovice [584061]`.
	 */
	title: string
	/**
	 * The `<updated>` the service document states, which is this archive's modification time.
	 */
	updated: string
	/**
	 * The dataset feed for this municipality, which lists the same data in both projections.
	 */
	datasetFeedURL: string
	/**
	 * The archive, composed from the base the feed declares for the requested projection.
	 */
	downloadURL: string
	/**
	 * The file name the archive is written under, which is what the adapter globs.
	 */
	filename: string
}

/**
 * The trailing numeric component of an INSPIRE dataset identifier code,
 * `CZ-00025712-CUZK_AD_584061` → `584061`.
 */
const IDENTIFIER_CODE_SUFFIX = /_(\d+)$/u

/**
 * The municipality code a title states in brackets, `… obec: Unkovice [584061]` → `584061`.
 */
const TITLE_CODE = /\[(\d+)\]\s*$/u

/**
 * The municipality code of one entry, read from its INSPIRE identifier and checked against its title.
 *
 * Both spellings are read because the code is the file name the archive is composed
 * and stored under, so a disagreement between the publisher's two statements of it
 * would silently store one municipality's addresses under another's name.
 *
 * @throws When either statement is missing or the two disagree, which reads as a change
 * in the publisher's layout rather than as a municipality without a code.
 */
export function municipalityCodeOf(entry: { title: string; identifierCode: string | null }): string {
	const fromIdentifier = IDENTIFIER_CODE_SUFFIX.exec(entry.identifierCode ?? "")?.[1]
	const fromTitle = TITLE_CODE.exec(entry.title)?.[1]

	if (!fromIdentifier) {
		throw new Error(
			`${CZ_CUZK_SERVICE_FEED_URL}: the entry titled "${entry.title}" states the dataset identifier ` +
				`${stringifyJSON(entry.identifierCode)}, which ends in no municipality code`
		)
	}

	if (!fromTitle) {
		throw new Error(
			`${CZ_CUZK_SERVICE_FEED_URL}: the entry titled "${entry.title}" states no municipality code in brackets, ` +
				`so its identifier's ${fromIdentifier} could not be checked against the title`
		)
	}

	if (fromIdentifier !== fromTitle) {
		throw new Error(
			`${CZ_CUZK_SERVICE_FEED_URL}: the entry titled "${entry.title}" states municipality ${fromTitle} in its ` +
				`title and ${fromIdentifier} in its dataset identifier, so the archive it names is ambiguous`
		)
	}

	return fromIdentifier
}

/**
 * The base URL the feed declares for one projection.
 *
 * Matched on the href's last path segment rather than on the link's `title`,
 * because the segment is the EPSG code itself while the title is a Czech-language label.
 *
 * @throws When the feed declares no base for the requested projection, naming the ones it does
 * declare, so a publisher that moves its files reports itself instead of composing a dead URL.
 */
export function projectionBaseURL(feed: AtomFeed, projection: CzCuzkProjection): string {
	const bases = feed.links.filter((link: AtomLink) => link.rel === "next")
	const found = bases.find((link) => link.href.replace(/\/+$/u, "").endsWith(`/${projection}`))

	if (!found) {
		throw new Error(
			`${CZ_CUZK_SERVICE_FEED_URL}: the feed declares no download base ending in /${projection}. ` +
				`Its rel="next" links are ${bases.length ? bases.map((link) => link.href).join(", ") : "absent"}.`
		)
	}

	return found.href.replace(/\/+$/u, "")
}

/**
 * The municipalities the service document lists, with the archive URL for one projection.
 *
 * @throws When the feed lists no entry, when two entries claim one municipality code — which
 * would make one archive overwrite the other — or when an entry carries no dataset feed link.
 */
export function readCzCuzkServiceFeed(feed: AtomFeed, projection: CzCuzkProjection): readonly CzMunicipalityDataset[] {
	if (!feed.entries.length) {
		throw new Error(
			`${CZ_CUZK_SERVICE_FEED_URL}: the service document holds no <entry>, so the municipalities it offers ` +
				`could not be read`
		)
	}

	const base = projectionBaseURL(feed, projection)
	const datasets: CzMunicipalityDataset[] = []
	const seen = new Set<string>()

	for (const entry of feed.entries) {
		const code = municipalityCodeOf(entry)

		if (seen.has(code)) {
			throw new Error(
				`${CZ_CUZK_SERVICE_FEED_URL}: municipality ${code} is listed twice, so one of the two archives ` +
					`would overwrite the other`
			)
		}

		seen.add(code)

		// The entry's `alternate` link is its dataset feed.
		// The `describedby` link beside it is the ISO 19139 metadata record.
		// Reading either as the other costs a request that answers XML of the wrong kind.
		const datasetFeed = linkWithRel(entry.links, "alternate")

		if (!datasetFeed?.href) {
			throw new Error(
				`${CZ_CUZK_SERVICE_FEED_URL}: the entry for municipality ${code} carries no rel="alternate" link, ` +
					`so its dataset feed could not be read`
			)
		}

		datasets.push({
			code,
			title: entry.title,
			updated: entry.updated,
			datasetFeedURL: datasetFeed.href,
			downloadURL: `${base}/${code}.zip`,
			filename: `${code}.zip`,
		})
	}

	return datasets
}

/**
 * The archive link a dataset feed states for one projection.
 *
 * Read only when {@linkcode HarvestCzCuzkOptions.resolveThroughDatasetFeed} is set.
 * The feed holds one entry per projection, each with one `alternate` link, and the projection is
 * identified by the href's own path segment for the same reason {@linkcode projectionBaseURL} uses it.
 *
 * @throws When the dataset feed states no link for the requested projection.
 */
export function datasetFeedArchiveURL(feed: AtomFeed, projection: CzCuzkProjection, context: string): string {
	for (const entry of feed.entries) {
		const link = linkWithRel(entry.links, "alternate")

		if (link?.href.includes(`/${projection}/`)) return link.href
	}

	throw new Error(
		`${context}: the dataset feed states no alternate link under /${projection}/, so the archive for that ` +
			`projection could not be read`
	)
}

/**
 * One archive, as the harvest's manifest records it.
 *
 * {@linkcode SourceManifest}'s five fields plus what a re-run needs: the modification time
 * the service document stated for this municipality, and the one the host served it under.
 */
export interface CzCuzkArchiveEntry extends SourceManifest {
	municipality_code: string
	/**
	 * The `<updated>` the service document stated when this archive was fetched.
	 *
	 * A later run that reads the same value for this municipality leaves the file alone.
	 * This is the field that makes the harvest resumable without a request per municipality.
	 */
	feed_updated: string
	/**
	 * The `Last-Modified` the host served the archive under, or `null` where it served none.
	 *
	 * Recorded rather than compared: {@linkcode CzCuzkArchiveEntry.feed_updated}
	 * answers the same question without a request.
	 */
	last_modified: string | null
}

/**
 * The harvest's `MANIFEST.json`.
 */
export interface CzCuzkHarvestManifest extends SourceCollectionManifest {
	/**
	 * The projection the archives in this directory are in.
	 *
	 * Recorded because the two projections share a file name, so a directory holding
	 * both would be read by the adapter as two copies of every address.
	 */
	projection: CzCuzkProjection
	/**
	 * How many municipalities the service document listed when this manifest was written.
	 *
	 * The denominator for `files`, read from the feed on each run rather than fixed here.
	 */
	municipalities_listed: number
	files: CzCuzkArchiveEntry[]
}

export interface HarvestCzCuzkOptions {
	/**
	 * Where the archives and the manifest are written, which is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Which projection to harvest.
	 * Defaults to `epsg-4258`.
	 */
	projection?: CzCuzkProjection
	/**
	 * Harvest only these municipality codes, for a probe or for a repair of named municipalities.
	 *
	 * A code the service document does not list is reported as a failure rather than ignored.
	 */
	municipalities?: readonly string[]
	/**
	 * Stop after this many municipalities, counting the ones already on disk.
	 *
	 * A bounded run rather than all 6,258.
	 */
	limit?: number
	/**
	 * Take each archive's URL from its own dataset feed instead of composing it
	 * from the base the service document declares.
	 *
	 * Costs one extra request per municipality and asks the publisher rather than composing.
	 */
	resolveThroughDatasetFeed?: boolean
	/**
	 * Re-read the sha256 of every archive already on disk instead of comparing its byte count.
	 *
	 * The default compares the recorded byte count against the file's size, which is one `stat`.
	 * This re-hashes, which reads every archive in the directory.
	 */
	verifyDigests?: boolean
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Whether the archive recorded for one municipality is still the one the feed now describes.
 *
 * Three conditions, and the first is what saves 6,258 requests: the service
 * document states the same modification time it stated when the file was fetched,
 * the file is still there, and it is still the length that was recorded for it.
 */
async function isCurrent(
	recorded: CzCuzkArchiveEntry | undefined,
	dataset: CzMunicipalityDataset,
	path: PathBuilderLike,
	verifyDigests: boolean
): Promise<boolean> {
	if (!recorded || recorded.feed_updated !== dataset.updated) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	// The digest check reads the whole file rather than its metadata, which is why it is opt-in.
	if (!verifyDigests) return true

	return (await sha256File(path)) === recorded.sha256
}

/**
 * Harvest the municipalities the service document lists into `options.outputDir`.
 *
 * The client is injected so the harvest is testable without the network and so a caller
 * decides the pacing. {@linkcode fetchCzCuzk} is the registry entry point and supplies both.
 *
 * @returns What was fetched, what was already current, and which municipality codes failed.
 */
export async function harvestCzCuzk(
	client: Pick<APIClient, "fetch">,
	options: HarvestCzCuzkOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const projection = options.projection ?? "epsg-4258"
	const destDir = PathBuilder.from(options.outputDir)
	const manifestPath = destDir("MANIFEST.json")

	await makeDirectories(destDir)

	// MARK: Read the service document
	//
	// One request, and it states the modification time of every archive the service offers.

	report?.(`=== ${SLUG}: reading ${CZ_CUZK_SERVICE_FEED_URL}`)

	const { data: serviceXML } = await client.fetch<string>({
		method: "GET",
		url: CZ_CUZK_SERVICE_FEED_URL,
		responseType: "text",
	})

	// The service document shares the http 200 an exception report arrives on.
	assertNoOGCServiceException(serviceXML, `${SLUG} service document`)

	const feed = await readAtomFeed(feedChunks(serviceXML))
	const listed = readCzCuzkServiceFeed(feed, projection)

	report?.(`  ${listed.length} municipalities listed, projection ${projection} (${CZ_CUZK_PROJECTIONS[projection]})`)

	const wanted = selectMunicipalities(listed, options)

	report?.(`  ${wanted.selected.length} selected for this run`)

	// MARK: Fetch what the feed describes anew

	const previous = await loadCollectionFiles(manifestPath)
	const files = new Map<string, CzCuzkArchiveEntry>()

	// An entry for a municipality this run does not consider is carried through,
	// so a bounded run never drops what an earlier run recorded.
	for (const [filename, entry] of previous) {
		files.set(filename, entry as CzCuzkArchiveEntry)
	}

	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = [...wanted.unknown]

	for (const unknown of wanted.unknown) {
		report?.(`  ✗ municipality ${unknown} is not listed in the service document`)
	}

	const writeHarvestManifest = async (): Promise<void> => {
		const manifest: CzCuzkHarvestManifest = {
			source: SLUG,
			source_url: CZ_CUZK_SERVICE_FEED_URL,
			license: CZ_CUZK_LICENSE,
			attribution: CZ_CUZK_ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			projection,
			municipalities_listed: listed.length,
			files: [...files.values()].toSorted((left, right) =>
				left.municipality_code < right.municipality_code ? -1 : left.municipality_code > right.municipality_code ? 1 : 0
			),
		}

		await writeManifest(manifestPath, manifest)
	}

	for (const dataset of wanted.selected) {
		if (signal?.aborted) break

		const dest = destDir(dataset.filename)

		if (await isCurrent(files.get(dataset.filename), dataset, dest, options.verifyDigests ?? false)) {
			skipped++

			continue
		}

		try {
			const entry = await fetchArchive(client, dataset, {
				projection,
				dest,
				resolveThroughDatasetFeed: options.resolveThroughDatasetFeed ?? false,
			})

			files.set(dataset.filename, entry)

			fetched++

			report?.(`  ✓ ${dataset.code} ${ByteFormatter.formatIEC(entry.bytes)} sha256=${entry.sha256}`)
		} catch (error) {
			report?.(`  ✗ ${dataset.code}: ${error instanceof Error ? error.message : String(error)}`)
			failedCodes.push(dataset.code)

			continue
		}

		if (fetched % MANIFEST_INTERVAL === 0) {
			await writeHarvestManifest()
		}
	}

	await writeHarvestManifest()

	report?.(`=== ${SLUG} summary`)
	report?.(`fetched: ${fetched}`)
	report?.(`skipped: ${skipped} (the feed states the modification time already recorded)`)
	report?.(`failed:  ${failedCodes.length}`)

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}

/**
 * The municipalities this run considers, and the codes a caller named that the feed does not list.
 *
 * A code the caller asked for and the service document does not list is returned
 * rather than dropped, because a municipality that is not published is a different
 * condition from a selection that holds no municipality.
 */
function selectMunicipalities(
	listed: readonly CzMunicipalityDataset[],
	options: Pick<HarvestCzCuzkOptions, "municipalities" | "limit">
): { selected: readonly CzMunicipalityDataset[]; unknown: readonly string[] } {
	let selected = listed
	const unknown: string[] = []

	if (options.municipalities) {
		const byCode = new Map(listed.map((dataset) => [dataset.code, dataset]))
		const found: CzMunicipalityDataset[] = []

		for (const code of options.municipalities) {
			const dataset = byCode.get(code)

			if (dataset) {
				found.push(dataset)
			} else {
				unknown.push(code)
			}
		}

		selected = found
	}

	if (options.limit !== undefined) {
		selected = selected.slice(0, options.limit)
	}

	return { selected, unknown }
}

/**
 * Download one municipality's archive and answer the manifest entry for it.
 *
 * The archive is stored as it arrives.
 * The adapter opens it, because ČÚZK writes the ZIP64 sentinel into at least one central
 * directory and `adm-zip` inflates the member instead of trusting it.
 *
 * @throws When the body does not begin with a zip signature.
 * An error page served under http 200 is the body that fails this check.
 * An html page is therefore never written to disk under a `.zip` name.
 */
async function fetchArchive(
	client: Pick<APIClient, "fetch">,
	dataset: CzMunicipalityDataset,
	options: { projection: CzCuzkProjection; dest: PathBuilderLike; resolveThroughDatasetFeed: boolean }
): Promise<CzCuzkArchiveEntry> {
	let url = dataset.downloadURL

	if (options.resolveThroughDatasetFeed) {
		const { data: datasetXML } = await client.fetch<string>({
			method: "GET",
			url: dataset.datasetFeedURL,
			responseType: "text",
		})

		assertNoOGCServiceException(datasetXML, `${SLUG} dataset feed ${dataset.code}`)

		url = datasetFeedArchiveURL(
			await readAtomFeed(feedChunks(datasetXML)),
			options.projection,
			`${SLUG} dataset feed ${dataset.code}`
		)
	}

	const response = await client.fetch<ArrayBuffer>({
		method: "GET",
		url,
		responseType: "arraybuffer",
	})

	const bytes = Buffer.from(response.data)

	// The signature rather than a length: the advertised `type` is `application/gml+xml` on
	// a body the host serves as `application/zip`, so neither header settles what arrived.
	if (bytes.subarray(0, ZIP_SIGNATURE.length).toString("latin1") !== ZIP_SIGNATURE) {
		throw new Error(
			`${url} answered ${bytes.byteLength} bytes that do not begin with a zip signature, ` +
				`so the body is not the archive`
		)
	}

	await writeLocalFile(bytes, options.dest)

	// A stubbed transport may answer without headers at all, so the record of what the
	// host served the archive under is read defensively rather than indexed.
	const headers = response.headers as Record<string, string> | undefined

	return {
		municipality_code: dataset.code,
		filename: dataset.filename,
		source_url: url,
		downloaded_at: new Date().toISOString(),
		sha256: sha256Hex(bytes),
		bytes: bytes.byteLength,
		feed_updated: dataset.updated,
		last_modified: headers?.["last-modified"] ?? null,
	}
}

export interface FetchCzCuzkOptions
	extends
		BaseFetchOptions,
		Pick<
			HarvestCzCuzkOptions,
			"projection" | "municipalities" | "limit" | "resolveThroughDatasetFeed" | "verifyDigests" | "signal"
		> {
	/**
	 * The minimum spacing between two requests, in milliseconds.
	 *
	 * Defaults to {@linkcode CZ_CUZK_REQUEST_INTERVAL_MS}.
	 */
	minRequestIntervalMs?: number
}

/**
 * Harvest ČÚZK's INSPIRE Addresses archives into `<outRoot>/cz-cuzk/`.
 *
 * Re-runnable: a municipality whose recorded modification time still matches the service
 * document's and whose archive is still on disk at the recorded length costs no request.
 *
 * A full harvest is 6,259 requests — the service document plus one per municipality —
 * and an estimated 396 MB, from a mean of 63,337 bytes over a systematic sample
 * of 50 of the 6,258 archives on 2026-10-02.
 * The sample ran from 5,236 to 1,642,586 bytes, so the total is an estimate from
 * 50 measurements rather than a measurement of all 6,258.
 */
export async function fetchCzCuzk(options: FetchCzCuzkOptions, report?: (line: string) => void): Promise<FetchSummary> {
	await using client = new APIClient({
		displayName: SLUG,
		minRequestIntervalMs: options.minRequestIntervalMs ?? CZ_CUZK_REQUEST_INTERVAL_MS,
		retry: true,
	})

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await harvestCzCuzk(client, {
		outputDir: options.outRoot(SLUG),
		projection: options.projection,
		municipalities: options.municipalities,
		limit: options.limit,
		resolveThroughDatasetFeed: options.resolveThroughDatasetFeed,
		verifyDigests: options.verifyDigests,
		signal: options.signal,
		report,
	})
}
