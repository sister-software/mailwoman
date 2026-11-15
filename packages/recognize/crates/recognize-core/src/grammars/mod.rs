// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! The grammar modules `recognize` owns. Each module builds one family.

pub mod coordinates;
pub mod primitives;

use crate::family::Family;

/// Every family this crate owns, in the order the build tool writes them.
pub fn families() -> Vec<Family> {
	vec![primitives::family(), coordinates::family()]
}
