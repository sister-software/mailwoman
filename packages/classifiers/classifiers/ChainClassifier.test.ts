// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { assertClassification } from "../../../sdk/test/index.js"
import { ChainClassifier } from "./ChainClassifier.js"

const classifier = await new ChainClassifier().ready()

assertClassification(classifier, "chain", [
	["McDonalds", ["all"]],
	["McDonald's", ["all"]],
	["lone star steakhouse", ["all"]],
	["panda express", ["all"]],
])
