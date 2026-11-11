/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fetch the National Tax Agency's corporate-number register (法人番号公表サイト 全件データ): every
 *   corporation assigned a number, about 5,000,000 rows, with the head-office address as one string
 *   (国内所在地) plus the prefecture and municipality split out and the postcode. The nationwide CSV
 *   in Unicode is one zip of about 255 MB.
 *
 *   The agency issues the corporate number, so the identifier is an `identity` assertion. The head-office
 *   string beside it is an `observation` the corporation filed, on `registered-office` rows. The Overture
 *   rows the JP corpus is built from assert `address` on `premise` rows. That distinction matters when the two are mixed.
 *
 *   The agency states the three published fields may be used freely by anyone ("どなたでも自由にご利用
 *   いただくことができます"), with no attribution condition on the download page.
 *
 *   The file sits behind a form. The page hands out a per-session token. A post with that token,
 *   `event=download` and the file number of the nationwide Unicode CSV answers the zip. The file
 *   number is read off the page rather than pinned, because the agency re-issues the files monthly.
 *
 *   Invoke via `mailwoman corpus fetch houjin-jp`. Each monthly file is a snapshot under
 *   `$MAILWOMAN_DATA_ROOT/snapshots/houjin-jp/<YYYY-MM-DD>/`.
 */

import { makeDirectories, movePath, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import type { PathBuilder } from "path-ts"

import type { FetchSummary, SourceCollectionManifest } from "#tools/fetch/download"
import { attachmentFilename, cookieHeader, streamBodyToFile, withRetries, writeManifest } from "#tools/fetch/download"
import { fetchSnapshot, type SnapshotFetchOptions } from "#tools/fetch/storage"

const SLUG = "houjin-jp"
const PAGE_URL = "https://www.houjin-bangou.nta.go.jp/download/zenken/"
const FORM_URL = `${PAGE_URL}index.html`
const TOKEN_FIELD = "jp.go.nta.houjin_bangou.framework.web.common.CNSFWTokenProcessor.request.token"
const LICENSE = "国税庁法人番号公表サイト — the three published fields are free for anyone to use (利用規約)"
const ATTRIBUTION = "国税庁 法人番号公表サイト (National Tax Agency, Corporate Number Publication Site)"
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) mailwoman-corpus-fetch"

export type FetchHoujinJPOptions = SnapshotFetchOptions

/**
 * The nationwide row of the "CSV形式・Unicode" table stores the file number in its `doDownload(N)` handler.
 */
function nationwideUnicodeFileNumber(html: string): string | null {
	const start = html.indexOf('id="csv-unicode"')

	if (start === -1) return null
	const section = html.slice(start, html.indexOf('id="xml-unicode"', start))
	const row = /全国[\s\S]{0,600}?doDownload\((\d+)\)/.exec(section)

	return row?.[1] ?? null
}

/**
 * The date a nationwide file's attachment name states, as the vintage `YYYY-MM-DD`:
 * `00_zenkoku_all_20260831.zip` is `2026-08-31`.
 *
 * @throws When the name states no date, as the fallback name `zenkoku_all_<file number>.zip` does.
 */
export function houjinVintage(filename: string): string {
	const date = /_(\d{4})(\d{2})(\d{2})\.zip$/u.exec(filename)

	if (!date) throw new Error(`${SLUG}: the download's name ${filename} states no date, so its vintage is unknown`)

	return `${date[1]}-${date[2]}-${date[3]}`
}

/**
 * Downloads the nationwide Unicode CSV into its snapshot, `houjin-jp/<YYYY-MM-DD>/`.
 *
 * The date is known only from the download's attachment header, so the file is first
 * written to `houjin-jp/.download-<pid>/` beside the vintages.
 * The vintage is then read off its name, and the file moves into the vintage through `writeSnapshot`.
 * A refused vintage removes the download.
 */
export async function fetchHoujinJP(
	options: FetchHoujinJPOptions,
	report?: (line: string) => void
): Promise<FetchSummary> {
	const downloadDir = options.snapshots.root(SLUG, `.download-${process.pid}`)

	try {
		const downloaded = await downloadHoujinJP(downloadDir, report)

		if (!("filename" in downloaded)) return downloaded

		return await fetchSnapshot(
			options.snapshots,
			SLUG,
			houjinVintage(downloaded.filename),
			async (destDir) => {
				await movePath(downloadDir(downloaded.filename), destDir(downloaded.filename))
				await writeManifest(destDir("MANIFEST.json"), downloaded.manifest)

				return { fetched: 1, skipped: 0, failed: 0, failedCodes: [] }
			},
			report
		)
	} finally {
		await removePathIfPresent(downloadDir)
	}
}

async function downloadHoujinJP(
	destDir: PathBuilder,
	report?: (line: string) => void
): Promise<FetchSummary | { filename: string; manifest: SourceCollectionManifest }> {
	await makeDirectories(destDir)

	const page = await fetch(PAGE_URL, { headers: { "user-agent": USER_AGENT, accept: "text/html" } })

	if (!page.ok) throw new Error(`houjin-jp: the download page answered HTTP ${page.status}`)
	const html = await page.text()
	const token = new RegExp(`${TOKEN_FIELD.replaceAll(".", "\\.")}" value="([^"]+)"`).exec(html)?.[1]
	const fileNumber = nationwideUnicodeFileNumber(html)

	if (!token || !fileNumber) {
		report?.(
			`  ✗ the page carried ${token ? "a token" : "no token"} and ${fileNumber ? `file ${fileNumber}` : "no nationwide Unicode CSV row"}`
		)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: ["zenkoku-csv-unicode"] }
	}

	report?.(`=== ${SLUG}: nationwide CSV (Unicode), file ${fileNumber}`)

	let filename = `zenkoku_all_${fileNumber}.zip`
	let bytes: number

	try {
		bytes = await withRetries(
			async () => {
				// A fresh page per attempt.
				// The token is bound to the session cookie.
				// Either may have lapsed.
				const attemptPage = await fetch(PAGE_URL, { headers: { "user-agent": USER_AGENT, accept: "text/html" } })

				const attemptToken = new RegExp(`${TOKEN_FIELD.replaceAll(".", "\\.")}" value="([^"]+)"`).exec(
					await attemptPage.text()
				)?.[1]

				if (!attemptToken) throw new Error("the download page carried no token")

				const res = await fetch(FORM_URL, {
					method: "POST",
					headers: {
						"user-agent": USER_AGENT,
						cookie: cookieHeader(attemptPage),
						referer: PAGE_URL,
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({ [TOKEN_FIELD]: attemptToken, event: "download", selDlFileNo: fileNumber }),
					signal: AbortSignal.timeout(1_800_000),
				})

				if (!res.ok || !(res.headers.get("content-type") ?? "").includes("octet-stream")) {
					throw new Error(`HTTP ${res.status} ${res.headers.get("content-type") ?? ""}`)
				}

				filename = attachmentFilename(res, filename)

				return streamBodyToFile(res, destDir(filename))
			},
			{ report, label: filename }
		)
	} catch (error) {
		report?.(`  ✗ ${(error as Error).message}`)

		return { fetched: 0, skipped: 0, failed: 1, failedCodes: ["zenkoku-csv-unicode"] }
	}

	const dest = destDir(filename)
	const sha = await sha256File(dest)
	report?.(`  ✓ ${filename} ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256=${sha}`)

	const manifest: SourceCollectionManifest = {
		source: SLUG,
		source_url: PAGE_URL,
		license: LICENSE,
		attribution: ATTRIBUTION,
		downloaded_at: new Date().toISOString(),
		files: [{ source_url: FORM_URL, downloaded_at: new Date().toISOString(), filename, sha256: sha, bytes }],
	}

	return { filename, manifest }
}
