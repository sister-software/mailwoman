import { previewConfig } from "@mailwoman/site-kit/playwright"

// Port 7770 is the local origin the public data bucket's CORS rule admits, the same one the Earth preview uses; on any
// other port the browser refuses the glyph and search-artifact fetches, labels never draw and search never loads.
// The two previews never run at once: CI runs the Earth smoke, then one planetary smoke per body.
export default previewConfig({ port: 7770, remoteURLVariable: "MAILWOMAN_PLANETARY_URL" })
