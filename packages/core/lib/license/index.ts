/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   License posture utilities: the obligations an SPDX expression is known to carry, the branch of a dual license that
 *   applies to an installation, the signed commercial license key with its offline verification, and the engine stamp.
 *   Everything here is offline. The well-known freshness check is `@mailwoman/core/license/publication`, kept out of
 *   this barrel because it carries the HTTP client and this barrel is on the CLI launcher's path for every invocation.
 */

export * from "#license/configured"
export * from "#license/docs-site"
export * from "#license/key"
export * from "#license/obligations"
export * from "#license/register"
export * from "#license/stamp"
