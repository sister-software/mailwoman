/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `useBuildInfo()` — read the deployment's own `build.json`, the record a site's Vite build emits beside its bundle.
 *
 *   It answers which build a visitor is looking at, which is the question a bug report cannot answer from the URL: the
 *   apps deploy from `main` on every push. Therefore, "the site" is whatever commit was head at build time. The production
 *   smoke already fetches this file. this is the same record, read by the page that was built from it.
 *
 *   Absence is not an error. A dev server has no `build.json`, and a page must not show an error strip because it is
 *   running locally — so a failed fetch resolves to `null` and the caller renders nothing.
 */

import { useEffect, useState } from "react"

export interface BuildInfoRecord {
	/**
	 * The deployment's name: `mailwoman-earth`, `mailwoman-moon`, `mailwoman-mars`.
	 */
	app: string
	/**
	 * The short git revision the build was made from.
	 */
	revision: string
	/**
	 * The same revision, full length — what a commit URL wants.
	 */
	commit?: string
	/**
	 * ISO-8601 seconds, `Z` suffix.
	 */
	buildTime: string
}

/**
 * The deployment record, or `null` while it loads and whenever it cannot be read.
 */
export function useBuildInfo(url = "/build.json"): BuildInfoRecord | null {
	const [info, setInfo] = useState<BuildInfoRecord | null>(null)

	useEffect(() => {
		const controller = new AbortController()

		void (async () => {
			try {
				const response = await fetch(url, { signal: controller.signal })

				if (!response.ok) return

				const record = (await response.json()) as BuildInfoRecord

				// A record without a revision is not a build record. rendering half of one
				// would put an empty link in the footer rather than saying nothing.
				if (!controller.signal.aborted && record?.revision) {
					setInfo(record)
				}
			} catch {
				// A dev server with no build.json, an offline first paint, or an aborted unmount.
				// The footer shows its identity without a commit, which is the same
				// thing it showed before this existed.
			}
		})()

		return () => controller.abort()
	}, [url])

	return info
}
