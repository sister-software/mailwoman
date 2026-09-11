/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch Korea's local-government permit registry (지방행정인허가데이터): one CSV per permit category,
 *   every business a local authority has licensed, about 195 categories. Each row carries BOTH address
 *   forms of the same premises — `소재지전체주소` (the lot-number form, 지번) and `도로명전체주소` (the
 *   road-name form) — plus both postcodes and a planar coordinate (`좌표정보(x/y)`, EPSG:5174). That
 *   pairing is the cheapest dual-format signal Korean addresses offer, and the coordinate is the
 *   board's coordinate half, which is why this is the NOISY source for Korean and not a side dish.
 *
 *   The public-data portal labels the category files "이용허락범위 제한 없음" and links them to
 *   `file.localdata.go.kr`, which serves them behind a session: the category page sets the XSRF cookie,
 *   `/file/validate/download-count` is the portal's own rate check (429 when it wants a pause), and
 *   `/file/download/<slug>/info` streams the CSV. The files are CP949 as delivered; the adapter
 *   decodes. The restaurant category alone is about 700 MB.
 *
 *   Invoke via `mailwoman corpus fetch localdata-kr --out-root <path>`, optionally with
 *   `--categories general_restaurants,rest_cafes`.
 */

import { BYTES_PER_KIB } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { sleep } from "@mailwoman/core/utils/sleep"
import { join } from "path-ts"

import type {
	BaseFetchOptions,
	FetchSummary,
	SourceCollectionManifest,
	SourceManifest,
} from "#tools/fetch/download/index"
import {
	cookieHeader,
	loadCollectionFiles,
	streamBodyToFile,
	withRetries,
	writeManifest,
} from "#tools/fetch/download/index"

const SLUG = "localdata-kr"
const PORTAL = "https://file.localdata.go.kr"
const INDEX_URL = `${PORTAL}/file/general_restaurants/info`
const LICENSE = "이용허락범위 제한 없음 (data.go.kr label on each category file, e.g. 행정안전부_식품_일반음식점)"
const ATTRIBUTION = "행정안전부 (Ministry of the Interior and Safety), 지방행정인허가데이터"
const HTTP_TOO_MANY_REQUESTS = 429
const RATE_PAUSE_MS = 30_000

export interface FetchLocaldataKROptions extends BaseFetchOptions {
	/**
	 * Category slugs to fetch (the path segment of `/file/<slug>/info`). Defaults to every category the portal lists.
	 */
	categories?: string[]
}

interface Category {
	slug: string
	name: string
}

interface Session {
	cookie: string
	xsrf: string | undefined
	categories: Category[]
}

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) mailwoman-corpus-fetch"

/**
 * Open a session on the portal: the category page answers the XSRF cookie and the navigation that names every category.
 */
async function openSession(): Promise<Session> {
	const res = await fetch(INDEX_URL, {
		headers: { "user-agent": USER_AGENT, accept: "text/html", referer: "https://www.data.go.kr/" },
	})

	if (!res.ok) throw new Error(`localdata-kr: the category page answered HTTP ${res.status}`)
	const html = await res.text()
	const cookie = cookieHeader(res)
	const xsrf = /XSRF-TOKEN=([^;]+)/.exec(cookie)?.[1]
	const categories: Category[] = []
	const seen = new Set<string>()

	for (const [, slug, name] of html.matchAll(/href="\/file\/([a-z0-9_]+)\/info"[^>]*>\s*<span>([^<]+)<\/span>/g)) {
		if (!slug || !name || seen.has(slug)) continue
		seen.add(slug)
		categories.push({ slug, name: name.trim() })
	}

	return { cookie, xsrf, categories }
}

/**
 * The portal's own rate check; a 429 carries the pause it asks for in prose, so the caller sleeps and retries.
 */
async function validateDownloadCount(session: Session): Promise<boolean> {
	const headers: Record<string, string> = { "user-agent": USER_AGENT, cookie: session.cookie, referer: INDEX_URL }

	if (session.xsrf) {
		headers["X-XSRF-TOKEN"] = session.xsrf
	}

	const res = await fetch(`${PORTAL}/file/validate/download-count`, { headers })

	return res.status !== HTTP_TOO_MANY_REQUESTS
}

export async function fetchLocaldataKR(
	options: FetchLocaldataKROptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)
	const manifestPath = join(destDir, "MANIFEST.json")

	const session = await openSession()

	const wanted = options.categories?.length
		? session.categories.filter((category) => options.categories!.includes(category.slug))
		: session.categories

	report?.(`=== ${SLUG}: ${wanted.length} of ${session.categories.length} categories`)

	// A previous run's entries survive, keyed by file name, so a re-run after an interruption fetches only what is missing.
	const previous = await loadCollectionFiles(manifestPath)
	const files = new Map<string, SourceManifest>()
	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = []

	for (const category of wanted) {
		const filename = `${category.slug}.csv`
		const dest = join(destDir, filename)
		const url = `${PORTAL}/file/download/${category.slug}/info`
		const before = previous.get(filename)

		if (before && (await pathExists(dest))) {
			files.set(filename, before)

			skipped++

			continue
		}

		report?.(`--- ${category.name} (${category.slug})`)

		while (!(await validateDownloadCount(session))) {
			report?.(`  portal asks for a pause — sleeping ${RATE_PAUSE_MS / 1000}s`)
			await sleep(RATE_PAUSE_MS)
		}

		let bytes: number

		try {
			bytes = await withRetries(
				async () => {
					const res = await fetch(url, {
						headers: { "user-agent": USER_AGENT, cookie: session.cookie, referer: INDEX_URL, accept: "*/*" },
						signal: AbortSignal.timeout(1_800_000),
					})

					if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/csv")) {
						throw new Error(`HTTP ${res.status} ${res.headers.get("content-type") ?? ""} for ${category.slug}`)
					}

					return streamBodyToFile(res, dest)
				},
				{ report, label: category.slug }
			)
		} catch (error) {
			report?.(`  ✗ ${(error as Error).message}`)
			failedCodes.push(category.slug)

			continue
		}

		if (bytes < BYTES_PER_KIB) {
			report?.(`  ✗ ${bytes} bytes — an error page, not the register`)
			failedCodes.push(category.slug)

			continue
		}

		const sha = await sha256File(dest)
		files.set(filename, { source_url: url, downloaded_at: new Date().toISOString(), filename, sha256: sha, bytes })

		fetched++
		report?.(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)

		const manifest: SourceCollectionManifest = {
			source: SLUG,
			source_url: INDEX_URL,
			license: LICENSE,
			attribution: ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			files: [...files.values()],
		}

		await writeManifest(manifestPath, manifest)
	}

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}
