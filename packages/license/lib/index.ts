// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The rights of third-party data sources: license decisions and the operations they permit,
 *   the obligations an SPDX expression imposes, license strings read as records, and the build and
 *   layer policies that read them.
 *
 *   The package's one runtime dependency is zod, so `@mailwoman/core` and every leaf can import it. It holds no
 *   source register: a caller reads its own register and passes the decisions in.
 *
 *   `#product/*` holds Mailwoman's own product license: the token wire format, the trust register of
 *   signing keys shared with the Rust verifier in `crates/product-license`, the entitlement checks, the
 *   provenance manifest schema, and the published agreements and plans. Those modules are imported by
 *   subpath and stay out of this barrel. The signatures themselves are checked in
 *   `@mailwoman/core/license`, which owns the cryptography.
 */

export * from "#actions"
export * from "#admission"
export * from "#decision"
export * from "#expression"
export * from "#mixed"
export * from "#obligations"
export * from "#operations"
export * from "#policy"
export * from "#quote"
export * from "#record"
export * from "#refusals"
export * from "#reservation"
export * from "#tree"
