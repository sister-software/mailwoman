// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/sdk/test"

assert(
	// ---
	"Divadelná 41/3, Trnava",
	{
		street: ["Divadelná"],
		house_number: ["41/3"],
		locality: ["Trnava"],
	}
)
