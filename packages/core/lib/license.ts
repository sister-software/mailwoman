// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Mailwoman's own license: the branch of its dual license that applies to an installation,
 *   the signed commercial license key with its offline verification and the engine stamp.
 *
 *   The rights of third-party data sources, from license decisions to the obligations
 *   an SPDX expression imposes, are `@mailwoman/license`.
 *
 *   Everything here is offline.
 *   The well-known freshness check is `@mailwoman/core/license/publication`,
 *   kept out of this barrel because it imports the HTTP client and this barrel is
 *   on the CLI launcher's path for every invocation.
 */

export * from "#license/branch"
export * from "#license/configured"
export * from "#license/declaration"
export * from "#license/docs-site"
export * from "#license/install-id"
export * from "#license/key"
export * from "#license/key/file"
export * from "#license/register"
export * from "#license/stamp"
