// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { PersonClassifier } from "./PersonClassifier.ts"

const classifier = await new PersonClassifier().ready()

assertClassification(classifier, "person", [
	["Martin Luther King", ["all"]],
	["m l k", ["all"]],
	["MLK", ["all"]],
	["John Fitzgerald Kennedy", ["all"]],
	["j f k", ["all"]],
	["JFK", ["all"]],
	["cdg", ["fr"]],
	["Charles De Gaulle", ["fr"]],
])
