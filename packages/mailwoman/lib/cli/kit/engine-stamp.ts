/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The process's engine stamp, resolved once; the `mailwoman` package alone can read its manifest and the
 *   configured key, and an http surface's app factory must not import it, so each bin builds the stamp and
 *   hands it to its app as an option value.
 */

import {
	buildEngineStamp,
	type EngineStamp,
	type LicenseKeyVerification,
	licenseNoticeLines,
	verifyConfiguredLicenseKey,
} from "@mailwoman/core/license"

import { readMailwomanManifest } from "#cli/kit/metadata"

export interface ResolvedEngineStamp {
	stamp: EngineStamp
	/**
	 * The offline verification the stamp was built from, so the notice can name an expiry date.
	 */
	key?: LicenseKeyVerification
}

let resolved: Promise<ResolvedEngineStamp> | undefined

/**
 * Memoized for the process, because the manifest and configured key do not change
 * while it runs and every stamped output must agree.
 */
export function resolveEngineStamp(): Promise<ResolvedEngineStamp> {
	resolved ??= (async () => {
		const [manifest, key] = await Promise.all([readMailwomanManifest(), verifyConfiguredLicenseKey()])
		const stamp = buildEngineStamp({ version: manifest.version, expression: manifest.license, key })

		return { stamp, key }
	})()

	return resolved
}

/**
 * Written to stderr so stdout stays machine-readable for every `--json` consumer;
 * no notice is written when the commercial branch applies.
 */
export function printLicenseNotice(resolvedStamp: ResolvedEngineStamp): void {
	const lines = licenseNoticeLines(resolvedStamp.stamp, resolvedStamp.key)

	if (!lines) return

	for (const line of lines) {
		console.error(line)
	}
}
