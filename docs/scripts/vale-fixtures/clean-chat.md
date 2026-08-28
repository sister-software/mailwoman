# Clean chat fixture

This file is a realistic agent status reply that must pass `.vale-chat.ini`
with zero alerts of any severity — the Mailwoman style and the MailwomanChat
additions together. It models the register the output style asks for:
result first, the address in view, the denominator beside the score, the
entity named beside its ID.

`3 Mien, 64 Middlesex St, London E1 7EZ` loses the venue at the phrase
grouper. The resolver never receives `3 Mien`, so more rooftop data cannot
fix this case. Add the case to the phrase-boundary board before changing the
resolver.

The promotion eval reads 383 of 384 rows resolved. The one failure is the Portopetro
row, which asserts that a southeast bearing narrows the candidate set; the
bearing is dropped at tokenization, before the resolver runs. The fix
belongs in the tokenizer, and the row stays red until then.

The parent lookup now records Five Star Island (WOF 9000000119609) as the
parent of the locality span. Before the repair, the same lookup recorded no
parent at all.

Queen Street, Bristol now resolves to Bristol, England, and its ancestry
chain conforms to the gazetteer record. The three French control rows return
the same answers as before the change.

The cache serializes writes through one mutex. The assertion fails when the
fixture omits a parent. The storage layer uses SQLite, and the retry loop makes
three attempts before it returns the final error.

The source field records Overture, which distinguishes the row from WOF. The
decision keeps the marker reporting-only because routing would change ranking.
The postcode index supplies a country candidate when the input contains a full
UK postcode.

The unit test passed. The trace records that the retry ran once. The following
JSON object is the emitted artifact:
