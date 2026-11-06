// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The borrowed RGY1 reader and the lookups built on it.
//!
//! An [`Artifact`] borrows the caller's bytes, validates the envelope and directory once, and hands out
//! typed views over sections. No lookup allocates: a probe reads the table in place. The crate is
//! `no_std`, so the same code serves the native API and the WebAssembly adapter.
//!
//! `docs/rgy1.md` beside the package is the normative layout; this module follows it and refuses what
//! it does not describe.

#![no_std]

pub mod artifact;
pub mod key;
pub mod lookup;
pub mod sections;

pub use artifact::{Artifact, Error, Section};
pub use lookup::{Bitset, Column, IdTable, Relation, StringPool};
