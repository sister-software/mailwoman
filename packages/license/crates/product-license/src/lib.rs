// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Mailwoman's product license in Rust: the platform key (`mwl1`) and training grant (`mwt1`) verifier, the
//! training entitlement check, and the model provenance manifest signer and verifier.
//!
//! `docs/engineering/reference/product-license-tokens.mdx` specifies the formats. The trust register is
//! `packages/license/lib/product/trust-register.json`, which `@mailwoman/license/product/trust` also reads, and this
//! crate embeds it at build time. The tests run the fixtures under `packages/license/test/fixtures/product/`, which
//! the TypeScript tests in `@mailwoman/core` run as well.

pub mod entitlement;
pub mod keys;
pub mod provenance;
pub mod time;
pub mod token;

/// The environment variable the commercial trainer reads its training grant from; `TRAINING_GRANT_ENV` in
/// `@mailwoman/core/license/training`.
pub const TRAINING_GRANT_ENV: &str = "MAILWOMAN_TRAINING_GRANT";

/// The environment variables a managed export reads its provenance signing key from.
pub const PROVENANCE_KEY_ENV: &str = "MAILWOMAN_PROVENANCE_SIGNING_KEY";
pub const PROVENANCE_KID_ENV: &str = "MAILWOMAN_PROVENANCE_SIGNING_KID";
