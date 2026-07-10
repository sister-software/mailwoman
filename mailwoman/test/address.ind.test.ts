// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/test-kit"

assert(
	// ---
	"100, Mahalakshmi Rd, Ganesh Nagar, Kirti Nagar, New Sanghavi, Pimpri-Chinchwad, Maharashtra 411027",
	{
		// ---
		house_number: ["100"],
		street: ["Mahalakshmi Rd"],
		locality: ["Pimpri-Chinchwad"],
		region: ["Maharashtra"],
		postcode: ["411027"],
	}
)
