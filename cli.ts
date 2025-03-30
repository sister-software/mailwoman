#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import Pastel from "pastel"

const app = new Pastel({
	importMeta: import.meta,
	description: "A CLI tool for managing mailwoman projects",
	name: "Mailwoman CLI",
	version: "0.1.0",
})

await app.run()
