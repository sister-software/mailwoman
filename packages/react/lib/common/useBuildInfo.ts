/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `useBuildInfo()` — reads the deployment's own `build.json`, resolving a failed fetch to `null` because a dev server has no such file and the page must not show an error strip.
 */

import { useEffect, useState } from "react"

export interface BuildInfoRecord {
	/**
	 * The deployment's name: `mailwoman-earth`, `mailwoman-moon`, `mailwoman-mars`.
	 */
	app: string
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

				if (!controller.signal.aborted && record?.revision) {
					setInfo(record)
				}
			} catch {}
		})()

		return () => controller.abort()
	}, [url])

	return info
}
