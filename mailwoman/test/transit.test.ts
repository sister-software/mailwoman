// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/test-kit"

assert(
	// ---
	"Stop 1",
	{
		// ---
		venue: ["Stop 1"],
	}
)

assert(
	// ---
	"Stop 10010",
	{
		// ---
		venue: ["Stop 10010"],
	}
)
