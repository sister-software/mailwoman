// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   License posture utilities cover the obligations an SPDX expression is known to impose,
 *   the branch of a dual license that applies to an installation, the signed commercial
 *   license key with its offline verification and the engine stamp.
 *
 *   Everything here is offline.
 *   The well-known freshness check is `@mailwoman/core/license/publication`,
 *   kept out of this barrel because it imports the HTTP client and this barrel is
 *   on the CLI launcher's path for every invocation.
 */

export * from "#license/configured"
export * from "#license/decision"
export * from "#license/declaration"
export * from "#license/docs-site"
export * from "#license/install-id"
export * from "#license/key"
export * from "#license/key/file"
export * from "#license/obligations"
export * from "#license/record"
export * from "#license/register"
export * from "#license/stamp"
