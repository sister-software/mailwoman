/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The process's engine stamp, resolved once. The `mailwoman` package is the one place that can read its own manifest
 *   AND the configured key, and an HTTP surface's app factory must not import it (its bin may), so this module builds the
 *   stamp and each bin hands it to its app as an option value.
 */

import {
	buildEngineStamp,
	type EngineStamp,
	type LicenseKeyVerification,
	licenseNoticeLines,
	verifyConfiguredLicenseKey,
} from "@mailwoman/core/license"

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
		const stamp = buildEngineStamp({ version: manifest.version, expression: manifest.license, key })

		return { stamp, key }
	})

	return resolved
}

/**
 * Write the two-line notice to stderr, or nothing when the commercial branch applies. stderr, so stdout stays
 * machine-readable for every `--json` consumer.
 */
export function printLicenseNotice(resolvedStamp: ResolvedEngineStamp): void {
	const lines = licenseNoticeLines(resolvedStamp.stamp, resolvedStamp.key)

	if (!lines) return

	for (const line of lines) {
		console.error(line)
	}
}
