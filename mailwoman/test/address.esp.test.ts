// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Carrer d'Aragó 155 08011 Barcelona",
	{
		// ---
		street: ["Carrer d'Aragó"],
		house_number: ["155"],
		postcode: ["08011"],
		locality: ["Barcelona"],
	}
)
