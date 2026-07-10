// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "mailwoman/sdk/test"

import { PlaceClassifier } from "./PlaceClassifier.ts"

const classifier = await new PlaceClassifier().ready()

assertClassification(classifier, "place", [
	["stables", ["en"]],
	["swimming pool", ["en"]],
	["cafe", ["en", "fr", "de"]],
	["bar", ["en", "fr", "de"]],
])
