/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The paging, manifest and resumption machinery a paged WFS harvest shares.
 *
 * `./inspire-addresses.ts` owns what an INSPIRE Addresses service exposes — its capabilities, its
 * feature-type names and its GeoJSON pages. This module owns what a harvest of any paged WFS does
 * with those pages: it appends each one to the single file an adapter's `inputPath` points at,
 * records the page in a manifest beside it, and resumes from that manifest after an interrupted run.
 *
 * One file rather than one file per page, because the adapters read one. `#ee/adapters/ads/adapter`
 * opens `opts.inputPath` as newline-delimited JSON and `#pl/adapters/emuia/adapter` opens it as one
 * markup stream, so a directory of pages reaches neither. The manifest therefore records each page's
 * byte range inside that file: `offset`, `bytes` and the sha256 of exactly those bytes. A range is
 * what makes a page verifiable after it has been concatenated into its neighbours, and what lets an
 * interrupted append be truncated back to a page boundary rather than discarding the harvest.
 *
 * Three properties of a WFS make this harder than reading pages until they run out, and each is
 * handled here rather than by each country's module:
 *
 * 1. A service may ignore `startIndex` and answer every page with the first. `countWFSFeaturesByPaging`
 *    in `@mailwoman/core/api` refuses such a service by comparing two pages' leading feature. A
 *    harvest sees the same defect as two consecutive pages with equal bytes, which this refuses.
 * 2. A service's own `numberMatched` may be a per-request cap rather than a count. The caller states
 *    what its count is and where it came from, and {@linkcode PagedWFSHarvestOptions.featureCount}
 *    carries both. No count is written into this module, and a harvest with no usable count ends on
 *    the first page that returns no features.
 * 3. A page may return fewer features than `count` asks for. The next `startIndex` therefore advances
 *    by the features the service returned rather than by the page size, so a service that caps a page
 *    below the requested size is read whole instead of being read in strides that skip features.
 */

import { APIClient, assertNoOGCServiceException, type CheckedWFSFeatureCount } from "@mailwoman/core/api"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { readFileRange, tryStat } from "@mailwoman/core/fs/readers"
import { appendLocalTextFile, makeDirectories, removePathIfPresent, truncateFile } from "@mailwoman/core/fs/writers"
import { sha256File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { isoSecondsUTC } from "@mailwoman/core/utils"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { readManifest, writeManifest, type FetchSummary } from "#tools/fetch/download"

/**
 * The WFS version this repository's harvesters speak.
 *
 * 2.0.0 defines `startIndex` paging and the `hits` result type, and it is what
 * every service measured for these modules advertises.
 */
export const WFS_VERSION = "2.0.0"

/**
 * The file name a harvest writes its manifest under, beside the data file.
 */
export const HARVEST_MANIFEST_FILE = "MANIFEST.json"

/**
 * The first element of a response, as the service wrote it.
 */
export interface MarkupRoot {
	/**
	 * The opening tag verbatim, `<wfs:FeatureCollection …>`.
	 */
	tag: string
	/**
	 * The element's qualified name, prefix included.
	 */
	name: string
	/**
	 * The text between the name and the tag's terminator, which holds the attributes.
	 */
	attributes: string
	/**
	 * The offset just past the opening tag.
	 */
	contentStart: number
}

/**
 * The first element tag in a document.
 *
 * An index scan over the tag rather than a parse of the document: a harvest needs the
 * opening tag verbatim to open the file it assembles, and parsing a 1.6 MB page per request
 * to recover a tag that the first 400 bytes already hold costs a document parse per page.
 *
 * The leading `[A-Za-z_]` skips the XML declaration, which opens `<?xml`.
 */
const ROOT_OPENING_TAG = /<([A-Za-z_][\w.:-]*)([^>]*)>/u

/**
 * One attribute of an opening tag, by local name.
 */
function tagAttribute(root: MarkupRoot, attribute: string): string | undefined {
	const pattern = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${attribute}\\s*=\\s*"([^"]*)"`, "iu")

	return pattern.exec(root.attributes)?.[1]
}

/**
 * The count an opening tag states, or `null` where it states none or declines to state one.
 *
 * WFS 2.0 permits `numberMatched="unknown"`, which declines to count rather than counting none.
 */
export function rootCount(root: MarkupRoot, attribute: string): number | null {
	const value = tagAttribute(root, attribute)

	return value !== undefined && /^\d+$/u.test(value) ? Number(value) : null
}

/**
 * The document's first element tag.
 *
 * @throws When the body holds no element tag, so a response that is not markup
 * reads as unreadable rather than as a page of no features.
 */
export function readMarkupRoot(body: string, context: string): MarkupRoot {
	const match = ROOT_OPENING_TAG.exec(body)

	if (!match) {
		throw new TypeError(
			`${context}: the response carried no element tag, so its root could not be read, beginning ${stringifyJSON(body.slice(0, 120))}`
		)
	}

	return {
		tag: match[0],
		name: match[1] ?? "",
		attributes: match[2] ?? "",
		contentStart: match.index + match[0].length,
	}
}

/**
 * The content between a document's root tags, which for a `wfs:FeatureCollection` is its members.
 *
 * @throws When the root element is not closed, so a truncated transfer reads as
 * unreadable rather than as a page of no features.
 */
export function rootContent(body: string, root: MarkupRoot, context: string): string {
	const closing = `</${root.name}>`
	const end = body.lastIndexOf(closing)

	if (end < root.contentStart) {
		throw new TypeError(
			`${context}: the response's ${root.name} element is not closed, so the members it holds could not be separated from the document that carries them`
		)
	}

	return body.slice(root.contentStart, end)
}

/**
 * The attributes a page states about itself rather than about the feature type.
 *
 * A harvest assembles many pages under one root element, so the first page's counts
 * and timestamp would describe the assembled file wrongly.
 * They are dropped and the manifest records them per page.
 */
const PAGE_ATTRIBUTES = /\s(?:[\w.-]+:)?(?:numberMatched|numberReturned|timeStamp|next|previous)\s*=\s*"[^"]*"/giu

/**
 * A page's root tag with its namespace declarations kept and its per-page attributes
 * dropped, so it can open a file holding every page.
 */
export function collectionOpeningTag(root: MarkupRoot): string {
	return `<${root.name}${root.attributes.replace(PAGE_ATTRIBUTES, "")}>`
}

/**
 * One `GetFeature` response in a markup format, with what its root states about itself.
 */
export interface WFSMarkupPage {
	body: string
	root: MarkupRoot
	/**
	 * The `numberReturned` the root states, or `null` where it states none.
	 */
	numberReturned: number | null
	/**
	 * The `numberMatched` the root states, or `null` where it answers `unknown`.
	 */
	numberMatched: number | null
	/**
	 * The `timeStamp` the root states, or `null` where it states none.
	 */
	timeStamp: string | null
}

/**
 * Issues one `GetFeature` and reads the counts off the root element.
 *
 * @throws When the service answers an OGC exception report, so an HTTP 400 carrying
 * `ows:ExceptionCode` raises rather than being written into the harvest as a page.
 */
export async function readWFSMarkupPage(
	client: Pick<APIClient, "fetch">,
	options: { wfsURL: string; context: string; params: Readonly<Record<string, string>> }
): Promise<WFSMarkupPage> {
	const { data } = await client.fetch<string>({
		method: "GET",
		url: options.wfsURL,
		responseType: "text",
		params: { service: "WFS", version: WFS_VERSION, request: "GetFeature", ...options.params },
	})

	assertNoOGCServiceException(data, options.context)

	const root = readMarkupRoot(data, options.context)

	return {
		body: data,
		root,
		numberReturned: rootCount(root, "numberReturned"),
		numberMatched: rootCount(root, "numberMatched"),
		timeStamp: tagAttribute(root, "timeStamp") ?? null,
	}
}

/**
 * What a harvest asked the service for.
 *
 * Recorded in the manifest and compared against a resumed run's request: a harvest whose page
 * size, ordering or format changed cannot be continued from pages taken under the old one.
 */
export interface WFSHarvestRequest {
	wfsURL: string
	typeName: string
	outputFormat: string
	/**
	 * The property the service was asked to order by, or `null` where it grants no ordering.
	 *
	 * Without one, a resumed harvest rests on the service returning the same features
	 * in the same order as the earlier run, which no WFS guarantees.
	 */
	sortBy: string | null
}

/**
 * A feature count and how it was obtained.
 *
 * `count` is `null` where the service states no usable count.
 * The harvest then ends on the first page that returns no features, and
 * `because` records what the service said instead.
 */
export interface FeatureCountStatement {
	count: number | null
	because: string
}

/**
 * The count a service states, or no count and the reason there is none.
 *
 * `readCheckedWFSFeatureCount` proves a reported `numberMatched` against a page of the
 * same type, which catches a service whose count is smaller than one of its own pages.
 * It cannot catch a count that equals the service's page cap: no page can return more
 * features than the cap, so the page it asks for agrees with the cap every time.
 *
 * Poland's service is that case.
 * Measured 2026-10-02, `resultType=hits` at `startIndex=1` reports `numberMatched="1000"`, its
 * capabilities document advertises `CountDefault` as 1000, and a page returns at most 1,000 features.
 *
 * The reported number is the cap, and a harvest that read it as a count would store 1,000
 * of the 8.6 million features the service holds and record the type as read whole.
 * A reported count equal to the cap is therefore carried as no count.
 *
 * @param pageCap The largest page the service will serve, from its advertised `CountDefault`.
 */
export function statedFeatureCount(checked: CheckedWFSFeatureCount, pageCap: number | null): FeatureCountStatement {
	if (!checked.usable || checked.reported === null) {
		return { count: null, because: `the service stated no usable count: ${checked.because}` }
	}

	if (pageCap !== null && checked.reported === pageCap) {
		return {
			count: null,
			because: `the service reported numberMatched=${checked.reported}, which is the ${pageCap}-feature cap it advertises as CountDefault, so the number describes the largest page it will serve rather than what the type holds`,
		}
	}

	return {
		count: checked.reported,
		because: `the service reported numberMatched=${checked.reported} past index 0, and ${checked.because}`,
	}
}

/**
 * One page's contribution to the harvest file.
 */
export interface HarvestedPayload {
	/**
	 * The text appended to the harvest file for this page.
	 */
	payload: string
	/**
	 * Text written once, before the first page's payload — a document prolog
	 * and root tag, where the format needs one.
	 *
	 * Read from the first page a run writes and recorded in the manifest.
	 */
	header?: string
	/**
	 * Text written once the harvest reaches the end of the feature type, such as a closing root tag.
	 */
	footer?: string
	/**
	 * The features the service returned, which is what the next `startIndex` advances by.
	 *
	 * `null` where the service stated none.
	 * The harvest refuses that rather than reading it as zero.
	 */
	numberReturned: number | null
	numberMatched: number | null
	retrievedAt: string | null
}

/**
 * One page as the manifest records it.
 *
 * `offset` and `bytes` locate the page inside the harvest file and `sha256` is the digest of
 * exactly those bytes, so a page stays verifiable after the pages around it were appended.
 */
export interface WFSHarvestPageRecord {
	start_index: number
	/**
	 * The page size requested, which a service may answer with fewer features.
	 */
	count: number
	offset: number
	bytes: number
	sha256: string
	number_returned: number
	/**
	 * The `numberMatched` this page stated, where the service states a real one.
	 */
	number_matched: number | null
	retrieved_at: string | null
}

/**
 * The manifest a paged harvest writes beside its data file.
 *
 * Written after every page, so an interrupted run resumes from the last page that reached disk.
 */
export interface WFSHarvestManifest {
	source: string
	source_url: string
	wfs_version: string
	type_name: string
	output_format: string
	sort_by: string | null
	license: string
	attribution: string
	downloaded_at: string
	/**
	 * The file an adapter's `inputPath` points at, beside this manifest.
	 */
	filename: string
	page_size: number
	/**
	 * The service's own count where it states a usable one, and `null` where it does not.
	 */
	feature_count: number | null
	feature_count_source: string
	features_written: number
	header_bytes: number
	/**
	 * The text that closes the data file, appended once the harvest reaches the end of the type.
	 */
	footer: string
	/**
	 * The data file's byte length as this manifest describes it, footer included once complete.
	 */
	bytes: number
	/**
	 * The whole data file's digest, once the harvest is complete.
	 *
	 * `null` on a partial harvest, where the file is still being appended to
	 * and a digest of it would describe a prefix rather than the harvest.
	 */
	sha256: string | null
	complete: boolean
	pages: WFSHarvestPageRecord[]
}

export interface PagedWFSHarvestOptions {
	/**
	 * Names the service in every refusal.
	 */
	context: string
	/**
	 * The adapter slug this harvest feeds, stamped into the manifest.
	 */
	source: string
	/**
	 * Where the harvest is written.
	 *
	 * The adapter reads {@linkcode PagedWFSHarvestOptions.filename} inside this directory.
	 */
	outputDir: PathBuilderLike
	filename: string
	request: WFSHarvestRequest
	/**
	 * The license the address-source register elected for this publisher.
	 */
	license: string
	/**
	 * The attribution the elected terms require, or an empty string where they require none.
	 */
	attribution: string
	featureCount: FeatureCountStatement
	pageSize: number
	/**
	 * Stop once the manifest holds this many pages, for a probe rather than a full harvest.
	 *
	 * A cap on the manifest rather than on the run, so a second run under the same cap makes no request.
	 */
	maxPages?: number
	signal?: AbortSignal
	/**
	 * Reads one page and states the bytes the harvest file receives for it.
	 */
	readPage: (request: { startIndex: number; count: number }) => Promise<HarvestedPayload>
	report?: (line: string) => void
}

/**
 * Does a recorded manifest describe the request being made now?
 *
 * A harvest taken at another page size, ordering, format or type cannot be continued:
 * its pages were cut at different boundaries, and appending to them would leave
 * a file whose manifest describes neither half.
 */
function describesSameRequest(manifest: WFSHarvestManifest, options: PagedWFSHarvestOptions): boolean {
	return (
		manifest.source_url === options.request.wfsURL &&
		manifest.type_name === options.request.typeName &&
		manifest.output_format === options.request.outputFormat &&
		manifest.sort_by === options.request.sortBy &&
		manifest.page_size === options.pageSize &&
		manifest.filename === options.filename
	)
}

function emptyManifest(options: PagedWFSHarvestOptions): WFSHarvestManifest {
	return {
		source: options.source,
		source_url: options.request.wfsURL,
		wfs_version: WFS_VERSION,
		type_name: options.request.typeName,
		output_format: options.request.outputFormat,
		sort_by: options.request.sortBy,
		license: options.license,
		attribution: options.attribution,
		downloaded_at: isoSecondsUTC(),
		filename: options.filename,
		page_size: options.pageSize,
		feature_count: options.featureCount.count,
		feature_count_source: options.featureCount.because,
		features_written: 0,
		header_bytes: 0,
		footer: "",
		bytes: 0,
		sha256: null,
		complete: false,
		pages: [],
	}
}

/**
 * The offset the next page is appended at: the header plus every recorded page.
 */
function dataEndOf(manifest: WFSHarvestManifest): number {
	let end = manifest.header_bytes

	for (const page of manifest.pages) {
		end += page.bytes
	}

	return end
}

/**
 * The features the recorded pages hold between them.
 */
function featuresIn(pages: readonly WFSHarvestPageRecord[]): number {
	let features = 0

	for (const page of pages) {
		features += page.number_returned
	}

	return features
}

/**
 * The index the next page starts at: one past the last feature any recorded page reached.
 */
function nextStartIndexOf(pages: readonly WFSHarvestPageRecord[]): number {
	let next = 0

	for (const page of pages) {
		next = Math.max(next, page.start_index + page.number_returned)
	}

	return next
}

/**
 * The recorded pages that are actually on disk, with the file truncated back to the last of them.
 *
 * An interrupted run can leave a partial page at the end of the file,
 * or a footer the next page has to be appended past.
 * Both are resolved by cutting the file at the last page boundary the file reaches,
 * which is a page boundary rather than an arbitrary offset.
 *
 * @throws When the last surviving page's bytes no longer hash to what the manifest recorded,
 * which is a file that was altered rather than one that was cut short.
 */
async function reconcileHarvestFile(
	manifest: WFSHarvestManifest,
	dataPath: PathBuilderLike,
	context: string,
	report?: (line: string) => void
): Promise<WFSHarvestManifest> {
	const stat = await tryStat(dataPath)
	const size = stat?.size ?? 0

	const kept: WFSHarvestPageRecord[] = []

	for (const page of manifest.pages) {
		if (page.offset + page.bytes > size) break

		kept.push(page)
	}

	if (kept.length < manifest.pages.length) {
		report?.(
			`  ${manifest.pages.length - kept.length} of ${manifest.pages.length} recorded pages are not on disk — resuming from page ${kept.length}`
		)
	}

	const reconciled: WFSHarvestManifest = {
		...manifest,
		pages: kept,
		features_written: featuresIn(kept),
		complete: manifest.complete && kept.length === manifest.pages.length,
	}

	if (!kept.length) {
		// A header with no page behind it describes an empty document, so the file starts over.
		await removePathIfPresent(dataPath)

		return { ...reconciled, header_bytes: 0, footer: "", bytes: 0, sha256: null, complete: false }
	}

	const last = kept.at(-1)!
	const recordedBytes = await readFileRange(dataPath, last.offset, last.bytes)
	const digest = sha256Hex(recordedBytes)

	if (digest !== last.sha256) {
		throw new Error(
			`${context}: the ${last.bytes} bytes the manifest records for the page at startIndex ${last.start_index} hash to ${digest} rather than ${last.sha256}, so ${dataPath} holds something other than the harvest it describes`
		)
	}

	const dataEnd = dataEndOf(reconciled)

	if (reconciled.complete) {
		const expected = dataEnd + Buffer.byteLength(reconciled.footer)

		if (size === expected) return { ...reconciled, bytes: expected }

		report?.(`  The complete harvest records ${expected} bytes and ${size} are on disk — closing it again`)
	}

	if (size !== dataEnd) {
		await truncateFile(dataPath, dataEnd)
	}

	return { ...reconciled, bytes: dataEnd, sha256: null, complete: false }
}

/**
 * What a caller knows about the request it is about to make before it has asked the service.
 *
 * The type name and the output format come from a capabilities document, so they are not here:
 * the point of this check is to answer whether a harvest is already current without sending a request.
 */
export interface HarvestCurrencyExpectation {
	wfsURL: string
	sortBy: string | null
	pageSize: number
}

/**
 * The manifest of a harvest that needs no further request, or `null` where one does.
 *
 * A caller reads this before it reads a capabilities document, so a current harvest costs no request at all.
 * Two harvests need none:
 *
 * - A complete one whose data file still hashes to the digest the manifest records.
 * - A partial one that already holds `maxPages` pages, which is what a bounded probe asks for.
 *
 * @throws When a page's recorded byte range no longer hashes to its recorded digest,
 * so a file that was altered under its manifest is reported rather than used.
 */
export async function readCurrentHarvest(options: {
	outputDir: PathBuilderLike
	filename: string
	context: string
	expect: HarvestCurrencyExpectation
	maxPages?: number
}): Promise<WFSHarvestManifest | null> {
	const root = PathBuilder.from(options.outputDir)
	const manifest = await readManifest<WFSHarvestManifest>(root(HARVEST_MANIFEST_FILE))

	if (!manifest || !Array.isArray(manifest.pages)) return null

	const describesThisRequest =
		manifest.filename === options.filename &&
		manifest.source_url === options.expect.wfsURL &&
		manifest.sort_by === options.expect.sortBy &&
		manifest.page_size === options.expect.pageSize

	if (!describesThisRequest) return null

	const dataPath = root(options.filename)

	if (manifest.complete) {
		const stat = await tryStat(dataPath)

		if (!stat || stat.size !== manifest.bytes) return null

		return (await sha256File(dataPath)) === manifest.sha256 ? manifest : null
	}

	if (options.maxPages === undefined || manifest.pages.length < options.maxPages) return null

	const last = manifest.pages.at(-1)

	if (!last) return null

	const stat = await tryStat(dataPath)

	if (!stat || stat.size < last.offset + last.bytes) return null

	const digest = sha256Hex(await readFileRange(dataPath, last.offset, last.bytes))

	if (digest !== last.sha256) {
		throw new Error(
			`${options.context}: the ${last.bytes} bytes the manifest records for the page at startIndex ${last.start_index} hash to ${digest} rather than ${last.sha256}, so ${dataPath} holds something other than the harvest it describes`
		)
	}

	return manifest
}

/**
 * Harvests one WFS feature type into a single file, recording each page in a manifest beside it.
 *
 * Re-runnable in three ways, each of which makes no request:
 *
 * - A complete harvest whose file still hashes to the manifest's `sha256`.
 * - A partial harvest that already holds {@linkcode PagedWFSHarvestOptions.maxPages} pages.
 * - A partial harvest resumes at the page after the last one on disk,
 *   so the pages already taken are not taken again.
 *
 * @returns The manifest as written.
 */
export async function harvestPagedWFS(options: PagedWFSHarvestOptions): Promise<WFSHarvestManifest> {
	const root = PathBuilder.from(options.outputDir)

	await makeDirectories(root)

	const dataPath = root(options.filename)
	const manifestPath = root(HARVEST_MANIFEST_FILE)
	const recorded = await readManifest<WFSHarvestManifest>(manifestPath)
	const resumable = recorded !== null && Array.isArray(recorded.pages) && describesSameRequest(recorded, options)

	if (recorded !== null && !resumable) {
		options.report?.("  The manifest describes a different request — starting the harvest over")

		await removePathIfPresent(dataPath)
	}

	let manifest = resumable
		? await reconcileHarvestFile(recorded, dataPath, options.context, options.report)
		: emptyManifest(options)

	// The count may have become readable, or stopped being readable, since the recorded run.
	manifest = {
		...manifest,
		feature_count: options.featureCount.count,
		feature_count_source: options.featureCount.because,
	}

	if (manifest.complete) {
		const digest = await sha256File(dataPath)

		if (digest === manifest.sha256) {
			options.report?.(`  ✓ Already harvested (sha256 matches ${HARVEST_MANIFEST_FILE}) — no request made.`)

			return manifest
		}

		options.report?.(`  ${dataPath} hashes to ${digest} rather than ${manifest.sha256} — harvesting it again`)

		manifest = { ...manifest, complete: false, sha256: null }
	}

	const atPageCap = (): boolean => options.maxPages !== undefined && manifest.pages.length >= options.maxPages

	if (atPageCap()) {
		options.report?.(`  ✓ The manifest already holds ${manifest.pages.length} pages — no request made.`)

		return manifest
	}

	let startIndex = nextStartIndexOf(manifest.pages)
	let complete = false

	for (;;) {
		if (options.signal?.aborted) break

		if (atPageCap()) break

		if (manifest.feature_count !== null && manifest.features_written >= manifest.feature_count) {
			complete = true

			break
		}

		const page = await options.readPage({ startIndex, count: options.pageSize })

		if (page.numberReturned === null) {
			throw new Error(
				`${options.context}: the page at startIndex ${startIndex} stated no numberReturned, so what it holds is unknown rather than empty`
			)
		}

		if (page.numberReturned === 0) {
			complete = true

			break
		}

		const payloadBytes = Buffer.byteLength(page.payload)
		const digest = sha256Hex(page.payload)
		const previous = manifest.pages.at(-1)

		// A service that ignores `startIndex` answers every page with the first,
		// and a harvest of one would hold the same features repeated.
		// `countWFSFeaturesByPaging` refuses such a service by comparing two pages' leading feature.
		// Identical bytes is the same defect seen here.
		if (previous && previous.bytes === payloadBytes && previous.sha256 === digest) {
			throw new Error(
				`${options.context}: the page at startIndex ${startIndex} is byte-identical to the page at startIndex ${previous.start_index}, so the service is answering a new startIndex with the previous page rather than paging`
			)
		}

		if (!manifest.pages.length && page.header) {
			await appendLocalTextFile(page.header, dataPath)

			manifest = { ...manifest, header_bytes: Buffer.byteLength(page.header) }
		}

		const offset = dataEndOf(manifest)

		await appendLocalTextFile(page.payload, dataPath)

		manifest = {
			...manifest,
			downloaded_at: isoSecondsUTC(),
			footer: page.footer ?? manifest.footer,
			features_written: manifest.features_written + page.numberReturned,
			bytes: offset + payloadBytes,
			pages: [
				...manifest.pages,
				{
					start_index: startIndex,
					count: options.pageSize,
					offset,
					bytes: payloadBytes,
					sha256: digest,
					number_returned: page.numberReturned,
					number_matched: page.numberMatched,
					retrieved_at: page.retrievedAt,
				},
			],
		}

		await writeManifest(manifestPath, manifest)

		options.report?.(
			`  page ${manifest.pages.length} at startIndex ${startIndex}: ${page.numberReturned} features, ${ByteFormatter.formatIEC(payloadBytes)} (${manifest.features_written} written)`
		)

		// The service's own answer rather than the page size: a service that caps a page below the
		// requested size would otherwise be read in strides that skip the features it did not return.
		startIndex += page.numberReturned
	}

	if (complete) {
		if (manifest.footer) {
			await appendLocalTextFile(manifest.footer, dataPath)
		}

		// A feature type of no features still needs the file the adapter opens, and an empty append creates it.
		if (!(await tryStat(dataPath))) {
			await appendLocalTextFile("", dataPath)
		}

		const stat = await tryStat(dataPath)

		manifest = {
			...manifest,
			downloaded_at: isoSecondsUTC(),
			bytes: stat?.size ?? manifest.bytes,
			sha256: await sha256File(dataPath),
			complete: true,
		}
	}

	await writeManifest(manifestPath, manifest)

	return manifest
}

/**
 * What a registered `mailwoman corpus fetch` entry needs to run one service's harvest.
 */
export interface RunWFSHarvestOptions {
	/**
	 * The slug the harvest is written under and reported by, which matches the adapter's own id.
	 */
	slug: string

	/**
	 * Where the harvest directory sits, as the fetch registry hands it over.
	 */
	outRoot: (segment: string) => PathBuilderLike

	/**
	 * The data file inside the harvest directory, which is also the adapter's `inputPath`.
	 */
	filename: string

	/**
	 * What a stored manifest has to agree with before its harvest counts as current.
	 */
	expect: HarvestCurrencyExpectation

	/**
	 * The name the client reports itself under.
	 */
	displayName: string

	/**
	 * The floor between two requests to one government host.
	 */
	minRequestIntervalMs: number

	/**
	 * Runs the harvest against a client the caller does not own.
	 */
	harvest: (client: Pick<APIClient, "fetch">) => Promise<WFSHarvestManifest>

	/**
	 * A client to use rather than constructing one, which a test supplies.
	 */
	client?: Pick<APIClient, "fetch">

	/**
	 * A page cap, which makes an incomplete harvest a success.
	 */
	maxPages?: number
}

/**
 * Runs one service's harvest and reports it as a fetch registry entry does.
 *
 * Estonia and Poland wrote this sequence twice: ask whether the harvest on disk is
 * already current, construct a paced client unless the caller supplied one, run,
 * report, and decide whether an incomplete harvest is a failure.
 * A third WFS source would have written it a third time.
 *
 * The currency check runs before any request, so a complete harvest or a bounded
 * probe that already holds its pages makes no request at all.
 *
 * A bounded run stops short by instruction rather than by failure, so a page cap the caller
 * asked for reads as a success while an incomplete harvest without one reads as a failure.
 */
export async function runWFSHarvest(
	options: RunWFSHarvestOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	report?.(`=== ${options.slug}`)

	const destination = options.outRoot(options.slug)

	const current = await readCurrentHarvest({
		outputDir: destination,
		filename: options.filename,
		context: options.slug,
		expect: options.expect,
		maxPages: options.maxPages,
	})

	if (current) {
		report?.(
			`  ✓ Already harvested: ${current.features_written} features over ${current.pages.length} pages — no request made.`
		)

		return { fetched: 0, skipped: 1, failed: 0, failedCodes: [] }
	}

	let manifest: WFSHarvestManifest

	if (options.client) {
		manifest = await options.harvest(options.client)
	} else {
		// Bounded retry, because a harvest is many requests and one 5xx would otherwise end the run.
		await using client = new APIClient({
			displayName: options.displayName,
			minRequestIntervalMs: options.minRequestIntervalMs,
			retry: true,
		})

		manifest = await options.harvest(client)
	}

	report?.(
		`  ${manifest.complete ? "✓" : "partial:"} ${manifest.features_written} features over ${manifest.pages.length} pages, ${manifest.bytes} bytes`
	)

	const bounded = options.maxPages !== undefined && manifest.pages.length >= options.maxPages

	return manifest.complete || bounded
		? { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
		: { fetched: 0, skipped: 0, failed: 1, failedCodes: [options.slug] }
}
