// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Deprecation shim — `mailwoman wof graph` moved. One-minor-version courtesy redirect; remove after.
 */

import { Text } from "ink"
import { useCommandTask } from "mailwoman/cli-kit"

const WofShim = () => {
	useCommandTask(
		async () => {},
		() => 1
	)

	return <Text color="yellow">{"`mailwoman wof graph` moved: use `mailwoman gazetteer inspect graph`"}</Text>
}

export default WofShim
