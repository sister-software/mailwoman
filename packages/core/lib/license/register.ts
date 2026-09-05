/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The register of license signing keys: the one source both the shipped trust map and the well-known JSON on
 *   mailwoman.ai derive from, so the two cannot disagree. A key enters when `mailwoman license keygen` mints it and
 *   moves through three states:
 *
 *   - `active`: may sign and verify.
 *   - `retired`: may no longer sign; tokens it signed still verify offline until they expire.
 *   - `revoked`: compromised; online status refuses its tokens at once, and the trust map this module derives leaves
 *     it out, so the next release stops trusting it offline.
 *
 *   `mailwoman license register --write` regenerates the well-known file from this module, and the `license-register`
 *   health check refuses a tree where the two differ.
 */

/**
 * The three states a signing key moves through, in order; a key never moves back.
 */
export const LicenseKeyStatus = {
	Active: "active",
	Retired: "retired",
	Revoked: "revoked",
} as const

export type LicenseKeyStatus = (typeof LicenseKeyStatus)[keyof typeof LicenseKeyStatus]

export interface LicenseSigningKey {
	/**
	 * `licenseKeyID(publicKeyPEM, majorVersions[0])`; the register test holds every entry to that.
	 */
	kid: string
	publicKeyPEM: string
	/**
	 * The mailwoman major versions this key signs for.
	 */
	majorVersions: readonly number[]
	status: LicenseKeyStatus
}

/**
 * Every signing key ever registered, with its current status. `mailwoman license keygen` prints the entry to add; a key
 * leaves this list never, and changes status instead.
 */
export const LICENSE_SIGNING_KEYS: readonly LicenseSigningKey[] = [
	{
		kid: "v9-ecec29be",
		publicKeyPEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAwPWLp1gjTRCSKjPqrS5q1jw5WP7SlofcVap390Z2Te4=
-----END PUBLIC KEY-----
`,
		majorVersions: [9],
		status: LicenseKeyStatus.Active,
	},
]

/**
 * Key id → PEM public key for offline verification: every key that is not revoked.
 */
export function trustedLicenseSigningKeys(): Readonly<Record<string, string>> {
	return Object.fromEntries(
		LICENSE_SIGNING_KEYS.filter((key) => key.status !== LicenseKeyStatus.Revoked).map((key) => [
			key.kid,
			key.publicKeyPEM,
		])
	)
}

/**
 * The shape of the well-known file at `/.well-known/mailwoman/license-keys.json`.
 */
export interface PublishedLicenseKeys {
	format: "mailwoman-license-keys/1"
	$comment: string
	keys: Array<{
		kid: string
		algorithm: "Ed25519"
		publicKey: string
		majorVersions: number[]
		status: LicenseKeyStatus
	}>
}

const WELL_KNOWN_COMMENT =
	"The public halves of the commercial license signing keys, by key id, with each key's status. `mailwoman doctor --online` and `mailwoman license verify --online` read this to confirm a configured key's id is still active; offline verification uses the same keys shipped in @mailwoman/core/license. Derived from packages/core/lib/license/register.ts by `mailwoman license register --write`; edit the register, not this file."

export function publishedLicenseKeys(): PublishedLicenseKeys {
	return {
		format: "mailwoman-license-keys/1",
		$comment: WELL_KNOWN_COMMENT,
		keys: LICENSE_SIGNING_KEYS.map((key) => ({
			kid: key.kid,
			algorithm: "Ed25519",
			publicKey: key.publicKeyPEM,
			majorVersions: [...key.majorVersions],
			status: key.status,
		})),
	}
}
