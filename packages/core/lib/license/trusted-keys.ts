/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The public halves of the license signing keys this build trusts, keyed by the id `licenseKeyID` derives. A key
 *   enters here when `mailwoman license keygen` mints it, and leaves when it is retired; removing an entry is the
 *   revocation mechanism, applied by the next release. The same set is published at
 *   `https://mailwoman.ai/.well-known/mailwoman/license-keys.json`, which the doctor consults as a freshness check
 *   when a key is configured and the network answers.
 */

/**
 * Key id → PEM public key. Empty until `mailwoman license keygen` has minted a key and its public half is pasted here;
 * with no entries every token verifies as `unknown_key`, so an unregistered build cannot be talked into the commercial
 * branch. The well-known register on mailwoman.ai carries the same entries with a `status` per key.
 */
export const TRUSTED_LICENSE_SIGNING_KEYS: Readonly<Record<string, string>> = {
	// Minted 2026-09-03 for the 9.x line; the private half lives in the issuer's config root, never in git.
	"v9-ecec29be": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAwPWLp1gjTRCSKjPqrS5q1jw5WP7SlofcVap390Z2Te4=
-----END PUBLIC KEY-----
`,
}
