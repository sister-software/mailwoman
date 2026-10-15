# Exhibit 21 parser interface

SEC Exhibit 21 filings are semi-structured HTML rather than one stable format. This parser deliberately recognizes a
small set of measured table, list, and plain-text shapes. It is not a general HTML parser. Uncertain rows increment
`unparseable` instead of fabricating a subsidiary or jurisdiction.

## Document and HTML handling

The parser reads only the SGML `<TEXT>` window when one is present. `<head>`, script, and style blocks are discarded. The
entity decoder handles numeric references plus the small set of HTML entity names observed in filings, and tag stripping inserts
spaces so adjacent cells and inline elements cannot fuse words.

Tables are scanned with nesting depth so layout tables do not duplicate nested data tables. Rows are normalized to a
rectangular grid and blank columns are dropped. A table is accepted when it has a recognizable subsidiary/name column,
a recognizable jurisdiction column, a measured name-over-name shape, or a single-column list that holds only names. Decorative
rows, repeated headers, footnotes, percentage columns, and ambiguous three-or-more-value rows are rejected.

Multi-value table cells split only on structural block boundaries such as paragraphs, line breaks, and list items. A
cell containing ordinary inline markup remains one value. Paired name/jurisdiction lists must have equal cardinality.
Otherwise the parser abstains rather than guessing alignment.

## List and text fallback

List extraction takes each list item's own text and excludes nested child-list content. Plain-text fallback turns block
boundaries into lines, removes bullets and known document headings, and caps candidate entity names at twelve words.
Candidate lines may use a parenthesized jurisdiction, a tab or two-or-more-space column gap, or one conservative comma
split. A suffix that is only a corporate designator is part of the company name, never a jurisdiction.

The parser returns every confident `{name, jurisdiction?}` plus the count it declined to parse. A row without a jurisdiction
has an absent property rather than an empty string and never an inferred place.
