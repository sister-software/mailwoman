/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch Taiwan's company and business registers (公司登記資料, 商業登記資料) from the Ministry of
 *   Economic Affairs' commerce open-data platform, data.gcis.nat.gov.tw. The platform publishes the
 *   full registers as CSV files split by region (the six special municipalities each on their own,
 *   the rest of the island in four bands) and by industry letter, 148 files in all, each row carrying
 *   the registered address (公司地址) and, for companies, the tax office's business address
 *   (營業地址) as free text. This is the NOISY source for Taiwanese addresses: a person typed these.
 *
 *   License: 政府資料開放授權條款－第1版 (Open Government Data License, Taiwan, v1.0). The platform's
 *   own dialog states the condition that binds: attribution in the form it prescribes, or the grant is
 *   void from the start ("未盡顯名標示義務者，視為自始未取得開放資料之授權"). The manifest records the
 *   prescribed wording per file so the corpus build and the model card can carry it.
 *
 *   Invoke via `mailwoman corpus fetch gcis-tw --out-root <path>`.
 */

import { BYTES_PER_KIB } from "@mailwoman/core/fs/formatters"
import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { sleep } from "@mailwoman/core/utils/sleep"
import { join } from "path-ts"

import type { BaseFetchOptions, FetchSummary, SourceCollectionManifest, SourceManifest } from "#tools/fetch/download"
import { loadCollectionFiles, streamBodyToFile, withRetries, writeManifest } from "#tools/fetch/download"

const SLUG = "gcis-tw"
const PORTAL = "https://data.gcis.nat.gov.tw"
const CATALOG_URL = `${PORTAL}/od/datacategory`
const LICENSE = "政府資料開放授權條款－第1版 (Open Government Data License, Taiwan, v1.0) — http://data.gov.tw/license"
const ATTRIBUTION = "提供機關／經濟部商業發展署 [<dataset title>] — the 顯名聲明 each file's dialog prescribes"
const PACE_MS = 300

/**
 * The bulk register files: `<region><register>資料-<industry letter><industry>`. The per-industry API datasets and the
 * monthly new-registration lists share the catalog and are not these.
 */
const BULK_TITLE = /(公司登記資料|商業登記資料)-[A-Z]/

export type FetchGCISTWOptions = BaseFetchOptions

interface Dataset {
	title: string
	detailPath: string
}

/**
 * A file name a shell and a manifest can carry: the title with its punctuation folded to underscores.
 */
function filenameFor(title: string): string {
	return `${title
		.replaceAll(/[()（）、，/\\\s]+/g, "_")
		.replaceAll(/_+/g, "_")
		.replaceAll(/^_|_$/g, "")}.csv`
}

async function listBulkDatasets(): Promise<Dataset[]> {
	const res = await fetch(CATALOG_URL, { headers: { accept: "text/html" } })

	if (!res.ok) throw new Error(`gcis-tw: the catalog answered HTTP ${res.status}`)
	const html = await res.text()
	const datasets: Dataset[] = []

	for (const [, path, rawTitle] of html.matchAll(/<a[^>]*href="(\/od\/detail[^"]*)"[^>]*>([^<]+)<\/a>/g)) {
		const title = rawTitle?.trim()

		if (!path || !title || !BULK_TITLE.test(title)) continue
		datasets.push({ title, detailPath: path.replace(/;jsessionid=[^?]*/, "") })
	}

	return datasets
}

/**
 * The `/od/file?oid=…` link a dataset's detail page hands its download dialog.
 */
async function fileURLFor(dataset: Dataset): Promise<string | undefined> {
	const res = await fetch(`${PORTAL}${dataset.detailPath}`, { headers: { accept: "text/html" } })

	if (!res.ok) return undefined
	const html = await res.text()
	const path = /showDialog\('(\/od\/file\?oid=[^']+)'\)/.exec(html)?.[1]

	return path ? `${PORTAL}${path}` : undefined
}

export async function fetchGCISTW(options: FetchGCISTWOptions, report?: (line: string) => void): Promise<FetchSummary> {
	const destDir = join(options.outRoot, SLUG)
	await makeDirectories(destDir)
	const manifestPath = join(destDir, "MANIFEST.json")

	const datasets = await listBulkDatasets()
	report?.(`=== ${SLUG}: ${datasets.length} bulk register files in the catalog`)

	const previous = await loadCollectionFiles(manifestPath)
	const files = new Map<string, SourceManifest>()
	let fetched = 0
	let skipped = 0
	const failedCodes: string[] = []

	for (const dataset of datasets) {
		const filename = filenameFor(dataset.title)
		const dest = join(destDir, filename)
		const before = previous.get(filename)

		if (before && (await pathExists(dest))) {
			files.set(filename, before)

			skipped++

			continue
		}

		await sleep(PACE_MS)
		const url = await fileURLFor(dataset)

		if (!url) {
			report?.(`  ✗ no file link on the detail page for ${dataset.title}`)
			failedCodes.push(dataset.title)

			continue
		}

		report?.(`--- ${dataset.title}`)
		let bytes: number

		try {
			bytes = await withRetries(
				async () => {
					const res = await fetch(url, { headers: { accept: "*/*" }, signal: AbortSignal.timeout(1_800_000) })

					if (!res.ok) throw new Error(`HTTP ${res.status} for ${dataset.title}`)

					return streamBodyToFile(res, dest)
				},
				{ report, label: dataset.title }
			)
		} catch (error) {
			report?.(`  ✗ ${(error as Error).message}`)
			failedCodes.push(dataset.title)

			continue
		}

		if (bytes < BYTES_PER_KIB) {
			report?.(`  ✗ ${bytes} bytes — an error page, not the register`)
			failedCodes.push(dataset.title)

			continue
		}

		const sha = await sha256File(dest)
		files.set(filename, { source_url: url, downloaded_at: new Date().toISOString(), filename, sha256: sha, bytes })

		fetched++
		report?.(`  ✓ ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)

		const manifest: SourceCollectionManifest = {
			source: SLUG,
			source_url: CATALOG_URL,
			license: LICENSE,
			attribution: ATTRIBUTION,
			downloaded_at: new Date().toISOString(),
			files: [...files.values()],
		}

		await writeManifest(manifestPath, manifest)
	}

	return { fetched, skipped, failed: failedCodes.length, failedCodes }
}
