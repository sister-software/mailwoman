/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The process's engine stamp, resolved once. The `mailwoman` package is the one place that can read its own manifest
 *   AND the configured key, and the HTTP packages may not depend on it, so this module builds the stamp and the CLI
 *   entry points hand it to each app as an option value.
 */

import { $public } from "@mailwoman/core/env"
// The subpaths, not the `@mailwoman/core/license` barrel: the barrel re-exports the well-known freshness check and its
// HTTP client, and this module runs on every CLI invocation, `--version` included.
import { verifyConfiguredLicenseKey } from "@mailwoman/core/license/configured"
import type { LicenseKeyVerification } from "@mailwoman/core/license/key"
import { buildEngineStamp, type EngineStamp, licenseNoticeLines } from "@mailwoman/core/license/stamp"

import { readMailwomanManifest } from "#cli-kit/metadata"

export interface ResolvedEngineStamp {
	stamp: EngineStamp
	/**
	 * The offline verification the stamp was built from, so the notice can name an expiry date.
	 */
	key?: LicenseKeyVerification
}

let resolved: Promise<ResolvedEngineStamp> | undefined

/**
 * Resolve the stamp for this process. Memoized: the manifest and the configured key do not change while a process runs,
 * and every stamped output must agree.
 */
export function resolveEngineStamp(): Promise<ResolvedEngineStamp> {
	resolved ??= readMailwomanManifest().then((manifest) => {
		const key = verifyConfiguredLicenseKey()

		const stamp = buildEngineStamp({
			version: manifest.version,
			expression: manifest.license ?? "AGPL-3.0-only OR LicenseRef-Commercial",
			...(key ? { key } : {}),
			...($public.MAILWOMAN_DOCS_URL ? { docsURL: $public.MAILWOMAN_DOCS_URL } : {}),
		})

		return { stamp, ...(key ? { key } : {}) }
	})

	return resolved
}

/**
 * Write the two-line notice, or nothing when the commercial branch applies. `write` defaults to stderr, which keeps
 * stdout machine-readable for every `--json` consumer.
 */
export function printLicenseNotice(
	resolvedStamp: ResolvedEngineStamp,
	write: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): void {
	const lines = licenseNoticeLines(resolvedStamp.stamp, resolvedStamp.key)

	if (!lines) return

	for (const line of lines) {
		write(line)
	}
}
