/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Harvest the INSPIRE Addresses archives of the Dirección General del Catastro into the directory
 * `#es/adapters/catastro/adapter` reads.
 *
 * The service is a two-level ATOM download service. The national service document at
 * `https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/ES.SDGC.AD.atom.xml` lists one entry per
 * territorial office, each entry links that office's province feed, and a province feed lists one
 * zipped GML per municipality:
 *
 *     ES.SDGC.AD.atom.xml  →  ES.SDGC.ad.atom_<pp>.xml  →  A.ES.SDGC.AD.<ppmmm>.zip
 *
 * Measured 2026-10-03: the service document answered http 200 with 681,783 bytes holding 55
 * entries, sha256 `4342d37b6d5527eb7b8bebadc97966c90f1a041068ae9398b90183f2176898b9`.
 *
 * Five properties of this service decide the harvest's shape.
 *
 * 1. **Three of the entries belong to other publishers.** Fifty-two are titled
 *    `Territorial office <pp> <name>` and are the Dirección General del Catastro's own provinces.
 *    The other three are titled `Provincial Council of Bizkaia`, `… of Gipuzkoa` and
 *    `… of Navarra`, which publish their own cadastres through this feed and state their own terms.
 *    Each of those has its own address-source register row, its own license and its own adapter, so
 *    this harvest selects the territorial offices by a positive match on their title rather than by
 *    excluding three names. A feed that renames its offices then matches zero titles and raises.
 * 2. **A province feed declares ISO-8859-1 and means it, while the national feed declares UTF-8.**
 *    `ES.SDGC.ad.atom_15.xml` writes A Coruña's directory name with the byte `0xD1` for `Ñ`.
 *    Decoding that feed as UTF-8 yields U+FFFD, and the URL built from the replacement character
 *    answers an html error page under http 200 rather than the archive. So both levels are read as
 *    bytes and decoded through {@linkcode decodeDeclaredXML}, which reads each document's own
 *    declaration.
 * 3. **An archive URL cannot be composed, and the href it is read from is not request-ready.** The
 *    directory segment is the municipality's own name, so Madrid sits under `28900-MADRID` while
 *    the composable `28079` answers an html page. The publisher writes that segment with literal
 *    spaces and with non-ASCII letters, and {@linkcode archiveRequestURL} percent-encodes both.
 * 4. **The municipality code is stated twice, and the two are checked against each other.** An
 *    entry's title reads `55101-CEUTA addresses` and its archive is named
 *    `A.ES.SDGC.AD.55101.zip`. The file keeps the publisher's own name rather than one built from
 *    the code, so the code decides which entry is read and never where the file lands. A
 *    disagreement between the publisher's two statements of it is a change in the feed's layout
 *    rather than a municipality without a code.
 * 5. **Every entry of every feed states one `<updated>`, the edition's publication date.** All 55
 *    national entries and all 87 entries of `ES.SDGC.ad.atom_02.xml` read
 *    `2026-08-21T00:00:00Z`, so the value dates the publication rather than the file. It is still
 *    the freshness signal a re-run compares, because a new edition moves it. A skip requires the
 *    feed to state a value: where it states none, both sides read an empty string and an equality
 *    test would keep an archive of unknown age for as long as the feed stayed silent.
 *
 * A full harvest is one request for the service document, 52 for the province feeds and one per
 * municipality. The archives are small enough to buffer: Ceuta is 354,647 bytes, A Coruña 907,574
 * and Madrid 7,104,627, measured 2026-10-03. The harvest is dispatched serially through one
 * `APIClient` at {@linkcode ES_CATASTRO_REQUEST_INTERVAL_MS}, and
 * {@linkcode HarvestESCatastroOptions.provinces} and {@linkcode HarvestESCatastroOptions.limit}
 * bound a run that is not harvesting the whole country.
 *
 * The archives stay compressed. `#es/adapters/catastro/adapter` reads the GML member through
 * `inspireGMLChunks`, which inflates from the archive, and Ceuta's member is 11,861,975 bytes
 * against its archive's 354,647.
 */

import { APIClient, assertNoOGCServiceException } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { tryStat } from "@mailwoman/core/fs/readers"
import { decodeBytes } from "@mailwoman/core/fs/streams"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { ES_CATASTRO_ADAPTER_ID, ES_CATASTRO_LICENSE } from "#es/adapters/catastro/adapter"
import type { AtomFeed } from "#tools/fetch/atom"
import { feedChunks, linkWithRel, readAtomFeed } from "#tools/fetch/atom"
import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, writeManifest } from "#tools/fetch/download"
import { downloadZipArchive } from "#tools/fetch/zip-archive"

/**
 * The national ATOM service document, which lists one province feed per territorial office.
 */
export const ES_CATASTRO_SERVICE_FEED_URL = "https://www.catastro.hacienda.gob.es/INSPIRE/Addresses/ES.SDGC.AD.atom.xml"

/**
 * The attribution the publisher's own rights statement requires.
 *
 * A province feed's `<rights>` reads `This service can be used free of charge in every instance, as
 * long as that the D. G. of the Cadastre (Ministry of Finance) is mentioned as author and owner of
 * the information`, so a model card carrying this source credits the office in its own language.
 */
export const ES_CATASTRO_ATTRIBUTION = "Dirección General del Catastro (Ministerio de Hacienda)"

/**
 * The minimum spacing between two requests to `catastro.hacienda.gob.es`, in milliseconds.
 *
 * Four requests per second against one government host.
 * The publisher states no rate limit, and a national harvest is roughly 8,100 requests,
 * so the harvest is paced rather than parallel.
 */
export const ES_CATASTRO_REQUEST_INTERVAL_MS = 250

/**
 * The directory the harvest writes under, which is the adapter's `inputPath`.
 */
const SLUG = ES_CATASTRO_ADAPTER_ID

/**
 * How many archives are written between two manifest writes.
 *
 * The manifest is what makes an interrupted harvest resumable, and writing it after every
 * archive would rewrite a document with one entry per municipality once per municipality.
 * At this interval an interruption re-fetches at most this many archives that are already on disk.
 */
const MANIFEST_INTERVAL = 25

/**
 * How much of a document is read to find its encoding declaration.
 */
const DECLARATION_WINDOW = 512

/**
 * The encoding an XML declaration states, read from the head of the document.
 */
const DECLARED_ENCODING = /<\?xml[^>]*encoding="([^"]+)"/iu

/**
 * A national entry's title, `Territorial office 02 Albacete`.
 *
 * The three entries belonging to the foral cadastres are titled `Provincial Council of <name>`
 * and do not match, which is how they are left to their own adapters.
 */
const TERRITORIAL_OFFICE_TITLE = /^Territorial office\s+(\d{2})\s+(\S.*)$/u

/**
 * The province code a province feed's own file name states, `ES.SDGC.ad.atom_02.xml` → `02`.
 */
const PROVINCE_FEED_CODE = /atom_(\d{2})\.xml$/iu

/**
 * A municipality entry's title, `55101-CEUTA addresses`.
 */
const MUNICIPALITY_TITLE = /^(\d{5})-(.*?)\s+addresses$/u

/**
 * A municipality archive's file name, `A.ES.SDGC.AD.55101.zip`.
 */
const ARCHIVE_FILENAME = /^A\.ES\.SDGC\.AD\.(\d{5})\.zip$/iu

/**
 * The document's text, decoded from the encoding its own declaration states.
 *
 * The national feed declares UTF-8 and a province feed declares ISO-8859-1, so a reader
 * that fixed either encoding would mojibake the other publisher's accented place names.
 * A document that declares no encoding is decoded as UTF-8, which is what XML's own default states.
 */
export function decodeDeclaredXML(bytes: Uint8Array): string {
	const head = Buffer.from(bytes.subarray(0, DECLARATION_WINDOW)).toString("latin1")

	return decodeBytes(bytes, DECLARED_ENCODING.exec(head)?.[1] ?? "utf8")
}

/**
 * The URL an href is requested at.
 *
 * A province feed writes a municipality's directory segment as the publisher spells it,
 * with literal spaces and with non-ASCII letters: `…/15/15900-A CORUÑA/A.ES.SDGC.AD.15900.zip`.
 * `URL` percent-encodes both, which is what the host serves the archive at.
 */
export function archiveRequestURL(href: string): string {
	return new URL(href).toString()
}

/**
 * One territorial office, as the national service document states it.
 */
export interface ESCatastroProvince {
	/**
	 * The two-digit province code, which is also the first two digits of each of its municipality codes.
	 */
	code: string
	/**
	 * The office name the entry's title states, `Albacete`.
	 */
	name: string
	title: string
	/**
	 * This office's province feed, which lists one archive per municipality.
	 */
	provinceFeedURL: string
	/**
	 * The entry's `<updated>`, which dates the national edition.
	 */
	updated: string
}

/**
 * One municipality's archive, as its province feed states it.
 */
export interface ESCatastroMunicipalityDataset {
	provinceCode: string
	/**
	 * The five-digit cadastral municipality code.
	 */
	code: string
	/**
	 * The municipality name the entry's title states, `CEUTA`.
	 */
	name: string
	title: string
	/**
	 * The archive, percent-encoded as the host serves it.
	 */
	archiveURL: string
	/**
	 * The `<updated>` the province feed states for this municipality.
	 */
	updated: string
	/**
	 * The file name the archive is written under, which is the name the publisher gave it
	 * and the name the adapter globs.
	 */
	filename: string
}

/**
 * The territorial offices the national service document lists.
 *
 * @throws When the document holds no entry, when it holds no territorial-office entry at all,
 * when an office carries no province-feed link, or when two offices claim one province code.
 * Each of those would otherwise write zero archives while reporting a completed run.
 */
export function readESCatastroServiceFeed(feed: AtomFeed): readonly ESCatastroProvince[] {
	if (!feed.entries.length) {
		throw new Error(
			`${ES_CATASTRO_SERVICE_FEED_URL}: the service document holds no <entry>, so the territorial offices ` +
				`it offers could not be read`
		)
	}

	const provinces: ESCatastroProvince[] = []
	const seen = new Set<string>()

	for (const entry of feed.entries) {
		const titled = TERRITORIAL_OFFICE_TITLE.exec(entry.title.trim())

		// An entry that is not a territorial office belongs to a foral cadastre with its own
		// register row, license and adapter, so it is left out rather than refused.
		if (!titled) continue

		const code = titled[1]!
		const name = titled[2]!.trim()

		// The province feed is the entry's `enclosure` link.
		// The feed-level `describedby` link beside it is the ISO 19139 metadata record,
		// and reading either as the other costs a request that answers XML of the wrong kind.
		const link = linkWithRel(entry.links, "enclosure")

		if (!link?.href) {
			throw new Error(
				`${ES_CATASTRO_SERVICE_FEED_URL}: the entry titled ${stringifyJSON(entry.title)} carries no ` +
					`rel="enclosure" link, so its province feed could not be read`
			)
		}

		const fromHref = PROVINCE_FEED_CODE.exec(link.href)?.[1]

		if (fromHref !== undefined && fromHref !== code) {
			throw new Error(
				`${ES_CATASTRO_SERVICE_FEED_URL}: the entry titled ${stringifyJSON(entry.title)} states province ` +
					`${code} in its title and links ${link.href}, which names province ${fromHref}`
			)
		}

		if (seen.has(code)) {
			throw new Error(
				`${ES_CATASTRO_SERVICE_FEED_URL}: province ${code} is listed twice, so one province feed would ` +
					`be read in place of the other`
			)
		}

		seen.add(code)

		provinces.push({
			code,
			name,
			title: entry.title.trim(),
			provinceFeedURL: link.href,
			updated: entry.updated,
		})
	}

	if (!provinces.length) {
		throw new Error(
			`${ES_CATASTRO_SERVICE_FEED_URL}: none of the ${feed.entries.length} entries is titled ` +
				`"Territorial office <code> <name>", so no province of the Dirección General del Catastro ` +
				`could be selected. The titles read ${feed.entries.map((entry) => stringifyJSON(entry.title)).join(", ")}.`
		)
	}

	return provinces
}

/**
 * The municipalities one province feed lists.
 *
 * @throws When the feed holds no entry, when an entry carries no archive link,
 * when the municipality code its title states disagrees with the one its archive
 * is named for, or when two entries name one archive.
 */
export function readESCatastroProvinceFeed(
	feed: AtomFeed,
	province: Pick<ESCatastroProvince, "code" | "provinceFeedURL">
): readonly ESCatastroMunicipalityDataset[] {
	if (!feed.entries.length) {
		throw new Error(
			`${province.provinceFeedURL}: the province feed holds no <entry>, so the municipalities of province ` +
				`${province.code} could not be read`
		)
	}

	const datasets: ESCatastroMunicipalityDataset[] = []
	const seen = new Set<string>()

	for (const entry of feed.entries) {
		const link = linkWithRel(entry.links, "enclosure")

		if (!link?.href) {
			throw new Error(
				`${province.provinceFeedURL}: the entry titled ${stringifyJSON(entry.title)} carries no ` +
					`rel="enclosure" link, so its archive could not be read`
			)
		}

		// The publisher's own file name, taken off the href before it is percent-encoded,
		// so the file on disk is named the way the feed names it.
		const filename = link.href.slice(link.href.lastIndexOf("/") + 1)
		const fromFilename = ARCHIVE_FILENAME.exec(filename)?.[1]

		if (!fromFilename) {
			throw new Error(
				`${province.provinceFeedURL}: the entry titled ${stringifyJSON(entry.title)} links ` +
					`${stringifyJSON(filename)}, which is not named A.ES.SDGC.AD.<code>.zip`
			)
		}

		const titled = MUNICIPALITY_TITLE.exec(entry.title.trim())

		if (!titled) {
			throw new Error(
				`${province.provinceFeedURL}: the entry linking ${stringifyJSON(filename)} is titled ` +
					`${stringifyJSON(entry.title)}, which states no municipality code, so the archive's ` +
					`${fromFilename} could not be checked against the title`
			)
		}

		const fromTitle = titled[1]!

		if (fromTitle !== fromFilename) {
			throw new Error(
				`${province.provinceFeedURL}: the entry titled ${stringifyJSON(entry.title)} states municipality ` +
					`${fromTitle} and links an archive named for ${fromFilename}, so the municipality it offers ` +
					`is ambiguous`
			)
		}

		if (seen.has(filename)) {
			throw new Error(
				`${province.provinceFeedURL}: ${stringifyJSON(filename)} is listed twice, so one of the two ` +
					`archives would overwrite the other`
			)
		}

		seen.add(filename)

		datasets.push({
			provinceCode: province.code,
			code: fromTitle,
			name: titled[2]!.trim(),
			title: entry.title.trim(),
			archiveURL: archiveRequestURL(link.href),
			updated: entry.updated,
			filename,
		})
	}

	return datasets
}

/**
 * One archive, as the harvest's manifest records it.
 */
export interface ESCatastroArchiveEntry extends SourceManifest {
	province_code: string
	municipality_code: string
	/**
	 * The `<updated>` the province feed stated when this archive was fetched.
	 *
	 * A later run that reads the same value for this municipality leaves the file alone.
	 * The publisher moves it when it publishes a new edition.
	 */
	feed_updated: string
	/**
	 * The `Last-Modified` the host served the archive under, or `null` where it served none.
	 */
	last_modified: string | null
}

/**
 * The harvest's `MANIFEST.json`.
 */
export interface ESCatastroHarvestManifest extends SourceCollectionManifest {
	/**
	 * How many territorial offices the service document listed, read from the feed on each run.
	 */
	provinces_listed: number
	/**
	 * How many of those offices this run read a province feed for.
	 *
	 * A bounded run reads fewer, so this is the denominator for `municipalities_listed`
	 * rather than a count of the country.
	 */
	provinces_harvested: number
	/**
	 * How many municipalities the province feeds this run read listed between them.
	 */
	municipalities_listed: number
	files: ESCatastroArchiveEntry[]
}

export interface HarvestESCatastroOptions {
	/**
	 * Where the archives and the manifest are written, which is the adapter's `inputPath`.
	 */
	outputDir: PathBuilderLike
	/**
	 * Harvest only these two-digit province codes.
	 *
	 * A code the service document does not list is reported as a failure rather than ignored.
	 * Without this every one of the 52 province feeds is read, at one request each.
	 */
	provinces?: readonly string[]
	/**
	 * Harvest only these five-digit municipality codes, among the provinces selected.
	 *
	 * A code none of the selected province feeds lists is reported as a failure.
	 */
	municipalities?: readonly string[]
	/**
	 * Stop after this many municipalities, counting the ones already on disk.
	 */
	limit?: number
	/**
	 * Re-read the sha256 of every archive already on disk instead of comparing its byte count.
	 *
	 * The default compares the recorded byte count against the file's size, which is one `stat`.
	 */
	verifyDigests?: boolean
	signal?: AbortSignal
	report?: (line: string) => void
}

/**
 * Whether the archive recorded for one municipality is still the one the province feed describes.
 *
 * A skip requires the feed to state an `<updated>` value.
 * Where it states none, both sides read an empty string and an equality test would hold,
 * which would keep an archive of unknown age for as long as the feed stayed silent.
 */
async function isCurrent(
	recorded: ESCatastroArchiveEntry | undefined,
	dataset: ESCatastroMunicipalityDataset,
	path: PathBuilderLike,
	verifyDigests: boolean
): Promise<boolean> {
	if (!recorded || !dataset.updated || recorded.feed_updated !== dataset.updated) return false

	const stat = await tryStat(path)

	if (!stat || stat.size !== recorded.bytes) return false

	// The digest check reads the whole file rather than its metadata, which is why it is opt-in.
	if (!verifyDigests) return true

	return (await sha256File(path)) === recorded.sha256
}

/**
 * Reads one ATOM document, decoded from the encoding it declares.
 */
async function readFeed(
	client: Pick<APIClient, "fetch">,
	options: { url: string; context: string; signal?: AbortSignal }
): Promise<AtomFeed> {
	const { data } = await client.fetch<ArrayBuffer>({
		method: "GET",
		url: options.url,
		responseType: "arraybuffer",
		timeout: 120_000,
		signal: options.signal,
	})

	const text = decodeDeclaredXML(Buffer.from(data))

	// A feed shares the http 200 an exception report arrives on.
	assertNoOGCServiceException(text, options.context)

	return readAtomFeed(feedChunks(text))
}

/**
 * The provinces this run reads, and the codes a caller named that the service document does not list.
 */
function selectProvinces(
	listed: readonly ESCatastroProvince[],
	wanted: readonly string[] | undefined
): { selected: readonly ESCatastroProvince[]; unknown: readonly string[] } {
	if (!wanted) return { selected: listed, unknown: [] }

	const byCode = new Map(listed.map((province) => [province.code, province]))
	const selected: ESCatastroProvince[] = []
	const unknown: string[] = []

	for (const code of wanted) {
		const province = byCode.get(code)

		if (province) {
			selected.push(province)
		} else {
			unknown.push(code)
		}
	}

	return { selected, unknown }
}

/**
 * Harvest the municipalities the selected province feeds list into `options.outputDir`.
 *
 * The client is injected so the harvest is testable without the network and so a caller decides
 * the pacing. {@linkcode fetchESCatastro} is the registry entry point and supplies both.
 *
 * @returns What was fetched, what the feed states is already recorded, and which codes failed.
 * @throws When the service document lists no territorial office, or
 * when a selected province feed lists no municipality.
 * Either would otherwise answer `{fetched: 0, skipped: 0, failed: 0}`, which a caller
 * reads as a fetch that completed and found the publisher empty.
 */
export async function harvestESCatastro(
	client: Pick<APIClient, "fetch">,
	options: HarvestESCatastroOptions
): Promise<FetchSummary> {
	const { report, signal } = options
	const destDir = PathBuilder.from(options.outputDir)
	const manifestPath = destDir("MANIFEST.json")

	report?.(`=== ${SLUG}: reading ${ES_CATASTRO_SERVICE_FEED_URL}`)

	const service = await readFeed(client, {
		url: ES_CATASTRO_SERVICE_FEED_URL,
		context: `${SLUG} service document`,
		signal,
	})

	const listed = readESCatastroServiceFeed(service)

	report?.(`  ${listed.length} territorial offices listed of ${service.entries.length} entries`)

	const provinces = selectProvinces(listed, options.provinces)

	for (const code of provinces.unknown) {
		report?.(`  ✗ province ${code} is not listed in the service document`)
	}

	// Resolved before the directory is made, so a publisher that answers an exception
	// report leaves no empty source directory behind.
	await makeDirectories(destDir)

	const previous = await loadCollectionFiles(manifestPath)
	const files = new Map<string, ESCatastroArchiveEntry>()

	// An entry for a municipality this run does not consider is carried through,
	// so a bounded run never drops what an earlier run recorded.
	for (const [filename, entry] of previous) {
		files.set(filename, entry as ESCatastroArchiveEntry)
	}

	let fetched = 0
	let skipped = 0
	let municipalitiesListed = 0
	let provincesHarvested = 0
	const failedCodes: string[] = [...provinces.unknown]
	const requested = options.municipalities === undefined ? undefined : new Set(options.municipalities)
	const found = new Set<string>()

	const writeHarvestManifest = async (): Promise<void> => {
		const manifest: ESCatastroHarvestManifest = {
			source: SLUG,
			source_url: ES_CATASTRO_SERVICE_FEED_URL,
			license: ES_CATASTRO_LICENSE,
			attribution: ES_CATASTRO_ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			provinces_listed: listed.length,
			provinces_harvested: provincesHarvested,
			municipalities_listed: municipalitiesListed,
			files: [...files.values()].toSorted((left, right) =>
				left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0
			),
		}

		await writeManifest(manifestPath, manifest)
	}

	for (const province of provinces.selected) {
		if (signal?.aborted) break

		if (options.limit !== undefined && fetched + skipped >= options.limit) break

		report?.(`  province ${province.code} ${province.name}: reading ${province.provinceFeedURL}`)

		const provinceFeed = await readFeed(client, {
			url: province.provinceFeedURL,
			context: `${SLUG} province feed ${province.code}`,
			signal,
		})

		const municipalities = readESCatastroProvinceFeed(provinceFeed, province)

		provincesHarvested++
		municipalitiesListed += municipalities.length

		report?.(`    ${municipalities.length} municipalities listed`)

		for (const dataset of municipalities) {
			if (signal?.aborted) break

			if (options.limit !== undefined && fetched + skipped >= options.limit) break

			if (requested && !requested.has(dataset.code)) continue

			found.add(dataset.code)

			const dest = destDir(dataset.filename)

			if (await isCurrent(files.get(dataset.filename), dataset, dest, options.verifyDigests ?? false)) {
				skipped++

				continue
			}

			try {
				const delivered = await downloadZipArchive(client, {
					url: dataset.archiveURL,
					dest,
					timeout: 600_000,
					signal,
				})

				files.set(dataset.filename, {
					province_code: dataset.provinceCode,
					municipality_code: dataset.code,
					filename: dataset.filename,
					source_url: dataset.archiveURL,
					downloaded_at: new Date().toISOString(),
					sha256: delivered.sha256,
					bytes: delivered.bytes,
					feed_updated: dataset.updated,
					last_modified: delivered.lastModified,
				})

				fetched++

				report?.(`    ✓ ${dataset.code} ${ByteFormatter.formatIEC(delivered.bytes)} sha256=${delivered.sha256}`)
			} catch (error) {
				report?.(`    ✗ ${dataset.code}: ${error instanceof Error ? error.message : String(error)}`)
				failedCodes.push(dataset.code)

				continue
			}

			if (fetched % MANIFEST_INTERVAL === 0) {
				await writeHarvestManifest()
			}
		}
	}

	// A municipality a caller named and no selected province feed listed is reported
	// rather than dropped, because a municipality that is not published is a different
	// condition from a selection that holds no municipality.
	for (const code of requested ?? []) {
		if (found.has(code)) continue

		report?.(`  ✗ municipality ${code} is not listed by any province feed this run read`)
		failedCodes.push(code)
	}

	await writeHarvestManifest()

	report?.(`=== ${SLUG} summary`)
	report?.(`fetched: ${fetched}`)
	report?.(`skipped: ${skipped} (the province feed states the publication date already recorded)`)
	report?.(`failed:  ${failedCodes.length}`)

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}

/**
 * The path `#es/adapters/catastro/adapter` reads, given the root a fetch wrote under.
 *
 * The adapter takes one archive or a directory holding them, and a harvest writes a directory.
 */
export function esCatastroInputPath(outRoot: BaseFetchOptions["outRoot"]): PathBuilderLike {
	return outRoot(SLUG)
}

export interface FetchESCatastroOptions
	extends
		BaseFetchOptions,
		Pick<HarvestESCatastroOptions, "provinces" | "municipalities" | "limit" | "verifyDigests" | "signal"> {
	/**
	 * The minimum spacing between two requests, in milliseconds.
	 *
	 * Defaults to {@linkcode ES_CATASTRO_REQUEST_INTERVAL_MS}.
	 */
	minRequestIntervalMs?: number
}

/**
 * Harvest the Dirección General del Catastro's INSPIRE Addresses archives into `<outRoot>/es-catastro/`.
 *
 * Re-runnable: a municipality whose recorded publication date is still the one its province
 * feed states, and whose archive is still on disk at the recorded length, costs no request.
 */
export async function fetchESCatastro(
	options: FetchESCatastroOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	await using client = new APIClient({
		displayName: SLUG,
		minRequestIntervalMs: options.minRequestIntervalMs ?? ES_CATASTRO_REQUEST_INTERVAL_MS,
		retry: true,
	})

	// Awaited rather than returned: `await using` disposes the client when this scope exits,
	// and a disposed `APIClient` refuses every later request.
	return await harvestESCatastro(client, {
		outputDir: options.outRoot(SLUG),
		provinces: options.provinces,
		municipalities: options.municipalities,
		limit: options.limit,
		verifyDigests: options.verifyDigests,
		signal: options.signal,
		report,
	})
}
