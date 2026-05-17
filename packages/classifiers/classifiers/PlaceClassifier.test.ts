// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "../../../sdk/test/index.js"
import { PlaceClassifier } from "./PlaceClassifier.js"

const classifier = await new PlaceClassifier().ready()

assertClassification(classifier, "place", [
	["stables", ["en"]],
	["swimming pool", ["en"]],
	["cafe", ["en", "fr", "de"]],
	["bar", ["en", "fr", "de"]],
])
