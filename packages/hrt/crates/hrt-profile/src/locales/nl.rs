// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

// Ported from the basemaps fork's locales/NL.java (BSD-3-Clause, Protomaps).

//! The Netherlands: A-road shields first, then N-roads, then the city stadsroutes, whose per-municipality networks
//! (`NL:S:Amsterdam`, `NL:S:Rotterdam`, ...) share one shield under the fork's `NL:S-road` network.

use super::Locale;

const S_ROAD_PREFIX: &str = "NL:S:";
/// The collapsed stadsroute network the fork's sprites and styles are keyed to.
const S_ROAD_NETWORK: &str = "NL:S-road";
const NETWORK_PRIORITY: [&str; 3] = ["NL:A", "NL:N", S_ROAD_NETWORK];

pub struct Nl;

impl Locale for Nl {
	fn normalize_network(&self, network: &str) -> String {
		if network.starts_with(S_ROAD_PREFIX) {
			S_ROAD_NETWORK.to_owned()
		} else {
			network.to_owned()
		}
	}

	fn network_rank(&self, network: Option<&str>) -> usize {
		network
			.and_then(|network| NETWORK_PRIORITY.iter().position(|prefix| network.starts_with(prefix)))
			.unwrap_or(super::DEFAULT_RANK)
	}
}
