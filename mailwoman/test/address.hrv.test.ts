// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Zadarska 17, Pula",
	{
		// ---
		street: ["Zadarska"],
		house_number: ["17"],
		locality: ["Pula"],
	}
)
