/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Whether `data pull` may fetch a bundle, decided before any byte moves. A free bundle downloads as it always has.
 *   A licensed bundle needs a configured token that verifies and whose scope admits the bundle's tier. The refusal
 *   prints the three routes to a token, so the operator who meets it knows what to do next.
 */

import { docsSiteURL, type LicenseKeyVerification, scopeAdmits } from "@mailwoman/core/license"

import type { BundleArtifact, DataBundle } from "#data/bundles"

/**
 * The token this installation has configured, with its offline verification.
 */
export interface ConfiguredKey {
	token: string
	verification: LicenseKeyVerification
}

export type LicensedPullDecision =
	| { kind: "free" }
	| { kind: "granted"; token: string }
	| { kind: "refused"; lines: string[] }

/**
 * The three routes to a token, as the refusal and the setup wizard print them.
 */
export function licenseRouteLines(): string[] {
	return [
		'  mailwoman license declare --intent open-source --name "<project>" --project <url>   # free for an open-source project',
		'  mailwoman license evaluate --name "<you>" --email <address>                         # thirty days',
		`  ${docsSiteURL()}/license                                                          # commercial`,
	]
}

/**
 * The scope entry a licensed bundle is served under: its tier when it has one, otherwise its name.
 */
export function bundleArtifactName(bundle: DataBundle): string {
	return bundle.tier ?? bundle.name
}

/**
 * The name one artifact of a licensed bundle is requested under.
 *
 * A bundle with one artifact uses the bundle's name.
 * A bundle with several appends the artifact's local path after a slash, so the worker's catalog
 * has one entry per object while the token's scope is checked against the bundle's name.
 */
export function licensedArtifactName(bundle: DataBundle, artifact: BundleArtifact): string {
	const name = bundleArtifactName(bundle)

	return bundle.artifacts.length === 1 ? name : `${name}/${artifact.localPath}`
}

/**
 * The configured token with its offline verification, or `null` when none is configured.
 *
 * Read only when a licensed bundle asks, so a free pull touches no key.
 */
export async function readConfiguredKey(): Promise<ConfiguredKey | null> {
	const { readConfiguredLicenseToken, trustedLicenseSigningKeys, verifyLicenseKey } =
		await import("@mailwoman/core/license")

	const configured = await readConfiguredLicenseToken()

	if (!configured) return null

	return {
		token: configured.token,
		verification: await verifyLicenseKey(configured.token, { trustedKeys: trustedLicenseSigningKeys() }),
	}
}

/**
 * A presigned download of one licensed artifact.
 */
export interface GrantedDownload {
	url: string
	/**
	 * The object's size as the worker's catalog records it, the one check a presigned object admits.
	 */
	bytes: number | null
}

/**
 * Trade the token for a presigned URL of one licensed artifact.
 *
 * @throws When the worker refuses, is not provisioned, or does not answer,
 * with the worker's word in the message.
 */
export async function requestGrantedDownload(token: string, artifact: string): Promise<GrantedDownload> {
	const { requestDownload } = await import("@mailwoman/core/license/status")
	const { readInstallationID } = await import("@mailwoman/core/license")
	const install = await readInstallationID()
	const answer = await requestDownload({ token, artifact, ...(install ? { install } : {}) })

	switch (answer.status) {
		case "granted":
			return { url: answer.url, bytes: answer.bytes }
		case "refused":
			throw new Error(`${artifact}: the license worker refused the download (${answer.reason})`)
		case "unavailable":
			throw new Error(`${artifact}: the license worker's download bucket is not provisioned yet`)
		case "unreachable":
			throw new Error(`${artifact}: the license worker did not answer: ${answer.reason}`)
	}
}

/**
 * Decide whether a bundle may be pulled with the configured key.
 */
export function licensedPullDecision(bundle: DataBundle, configured: ConfiguredKey | null): LicensedPullDecision {
	if (bundle.access !== "licensed") return { kind: "free" }

	const header = `\`${bundle.name}\` is a licensed artifact. Get a token by one of:`

	if (!configured) return { kind: "refused", lines: [header, ...licenseRouteLines()] }

	const { verification } = configured

	if (verification.status === "expired") {
		return {
			kind: "refused",
			lines: [
				header,
				...licenseRouteLines(),
				`Your key expired on ${verification.payload.expires}: mailwoman license refresh`,
			],
		}
	}

	if (verification.status !== "valid") {
		return {
			kind: "refused",
			lines: [header, ...licenseRouteLines(), `Your configured key reads ${verification.status}.`],
		}
	}

	const artifact = bundleArtifactName(bundle)

	if (!scopeAdmits(verification.payload.scope, artifact)) {
		return {
			kind: "refused",
			lines: [
				header,
				...licenseRouteLines(),
				`Your key's scope excludes ${artifact}; its agreement covers other artifacts.`,
			],
		}
	}

	return { kind: "granted", token: configured.token }
}
