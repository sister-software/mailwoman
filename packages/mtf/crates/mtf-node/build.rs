// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

//! Sets the linker flags a Node addon needs: Node's symbols resolve when the process loads the addon.

fn main() {
	napi_build::setup();
}
