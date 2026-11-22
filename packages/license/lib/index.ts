// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The rights of third-party data sources: license decisions and the operations they permit,
 *   the obligations an SPDX expression imposes, license strings read as records, and the build and
 *   layer policies that read them.
 *
 *   The package has no runtime dependency, so `@mailwoman/core` and every leaf can import it. It holds
 *   no register: a caller reads its own register and passes the decisions in. Mailwoman's own dual
 *   license, its key and its stamp, are `@mailwoman/core/license`.
 */

export * from "#admission"
export * from "#decision"
export * from "#expression"
export * from "#mixed"
export * from "#obligations"
export * from "#operations"
export * from "#policy"
export * from "#record"
export * from "#refusals"
