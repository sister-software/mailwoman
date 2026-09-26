"""The soft-feed channels: per-piece clues painted from the RAW SURFACE, never from gold labels.

Every channel here computes the same value at train time and at inference. A channel that read a
label would teach the model to expect evidence the runtime cannot supply.

All five share one additive form, applied at the input layer before the transformer body:

    h_i  +=  c_i · (W · features_i + cue)

`c_i` is the per-token confidence, zero where no clue fires. That scaling is what makes a channel a
continuum rather than a switch: a token with no clue contributes no signal, so an encoder
given no features computes what an encoder built without the channel computes. There is no discrete
"no clue" embedding and no regime to switch between.

The five, and what each is for:

**Postcode anchor** — a uniform country posterior over the locale set plus a 2-d centroid, painted on
the postcode span. Position-local, which is the property the global locale FiLM lacks; the two
compose, anchor at the input and FiLM after the blocks. Robustness comes from a confidence CURRICULUM
applied upstream in the loader. It is painted beside the tokenizer rather than here, because locating
a postcode span needs piece offsets.

**Gazetteer anchor** — a multi-hot candidate-tag set (country/region/po_box/cedex/homograph) from the
codex lexicon. The homograph bit explicitly marks "context decides here". See `gazetteer_anchor.py`.

**Country lexicon** — `[country_surface, country_ambiguous]`. Country is a closed, enumerable class of
roughly 250 surfaces that the learned grammar mislabels in the WOF-admin leading-long-form case. It
gets its own projection and cue rather than a gazetteer slot, and is not zeroed near a postcode, so a
trailing "…12345 USA" keeps its clue.

**Street type** — a multi-hot from the codex street-type lexicon (rue, boulevard, street, straße, …),
reusing the gazetteer lexicon format and its matcher. A separate channel rather than a gazetteer slot
so an existing checkpoint loads bit-clean and no feature width shifts. The hypothesis it tests:
street-versus-locality labeling errors are literal evidence absence rather than mis-segmentation.

**Locality surface** — `[locality, locality_homograph]` over curated WOF locality and localadmin names,
homograph meaning the name occurs in two or more countries. It is the counterweight to street type: the
bundle doctrine is that the two must be weighed against each other in context, so neither becomes a
decisive soft rule on its own.
"""
