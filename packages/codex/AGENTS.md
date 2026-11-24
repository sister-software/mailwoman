# AGENTS.md

## Address conventions cite a primary document

A change to an address convention cites a primary document. A convention is a rendered layout, its line order, a
postcode position or a fixed prefix in `lib/address/`. The primary documents are three: the designated postal
operator's own published rules, the UPU Postal Addressing Systems description
(`https://www.upu.int/UPU/media/upu/PostalEntitiesFiles/addressingUnit/<iso3>En.pdf`), and the country's UPU S42
template.

libaddressinput's `fmt` and the OpenCage address-formatting templates are compiled datasets, and neither is a
citation. Most generated layouts came from libaddressinput, so a generated layout counts as uncited until someone
compares it with a primary document. A finding file or an earlier review is a lead. Open the document yourself.

A citation is a `LayoutCitation` from `lib/address/convention-claims.ts`. It records:

- the source,
- the document's URL,
- the date the document prints,
- the retrieval date,
- the sha256 of the retrieved file, computed with `sha256sum`,
- the example lines the decision rests on, verbatim.

It also lists each detail the layout doesn't print as the document does. A UPU reading's record in
`lib/address/layouts/description-records.ts` is its citation. Every other rendered layout's citation goes in
`lib/address/layouts/citations.ts`. A board locale cites the operator document beside its board rows.

`yarn mwops health layout-citations` lists every jurisdiction whose rendered layout cites no primary document. The
`debt` check pins that count as `uncitedAddressLayouts` in `lib/repo-health/baseline.json`. A layout added without a
citation fails `debt`. After a citation lowers the count, ratchet the baseline with `mwops health baseline debt`.
