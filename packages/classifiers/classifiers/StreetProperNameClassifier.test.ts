// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "../../../sdk/test/index.js"
import { StreetProperNameClassifier } from "./StreetProperNameClassifier.js"

const classifier = new StreetProperNameClassifier()

assertClassification(classifier, "street_proper_name", [
	["broadway", ["en"]],
	["esplanade", ["en"]],
])
