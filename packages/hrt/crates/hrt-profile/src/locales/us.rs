// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's locales/US.java (BSD-3-Clause, Protomaps).

//! The United States: Interstate shields first, then US highways, then every state, county and local network; and
//! the `:Local` and `:Express` carriageway networks share their base route's shield.

use super::Locale;

/// Networks by shield priority; the first matching prefix wins, and `US:` catches every state, county and local network.
const NETWORK_PRIORITY: [&str; 3] = ["US:I", "US:US", "US:"];
const CARRIAGEWAY_SUFFIXES: [&str; 2] = [":Local", ":Express"];

pub struct Us;

impl Locale for Us {
	fn normalize_network(&self, network: &str) -> String {
		for suffix in CARRIAGEWAY_SUFFIXES {
			if let Some(base) = network.strip_suffix(suffix) {
				return base.to_owned();
			}
		}
		network.to_owned()
	}

	fn network_rank(&self, network: Option<&str>) -> usize {
		network
			.and_then(|network| NETWORK_PRIORITY.iter().position(|prefix| network.starts_with(prefix)))
			.unwrap_or(super::DEFAULT_RANK)
	}
}
