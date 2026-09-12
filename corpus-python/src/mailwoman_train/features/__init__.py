"""The soft-feed channels: per-piece clues painted from the RAW SURFACE, never from gold labels.

Every channel here computes the same value at train time and at inference. A channel that read a
label would teach the model to expect evidence the runtime cannot supply.
"""
