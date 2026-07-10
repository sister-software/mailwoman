// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assert } from "mailwoman/test-kit"

assert(
	// ---
	"Rua Raul Leite Magalhães, 65, Tapiraí - SP, 18180-000, Brazil",
	{
		street: ["Rua Raul Leite Magalhães"],
		house_number: ["65"],
		locality: ["Tapiraí"],
		region: ["SP"],
		postcode: ["18180-000"],
		country: ["Brazil"],
	}
)
