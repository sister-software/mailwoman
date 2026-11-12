// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { previewConfig } from "@mailwoman/universe/site-kit/playwright"

// The public data bucket's CORS rule must admit http://localhost:7771.
// On a port it doesn't admit, the browser refuses every model, gazetteer
// and sprite fetch and the geocoder never becomes ready.
// The docs dev server holds port 7770.
export default previewConfig({ port: 7771, remoteURLVariable: "MAILWOMAN_EARTH_URL" })
