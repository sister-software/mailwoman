import { previewConfig } from "@mailwoman/site-kit/playwright"

// Port 7770 is the local origin the public data bucket's CORS rule already admits; on any other port the browser
// refuses every model, gazetteer and sprite fetch and the geocoder never becomes ready.
export default previewConfig({ port: 7770, remoteURLVariable: "MAILWOMAN_EARTH_URL" })
