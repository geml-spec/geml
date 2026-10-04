// The fixed bounds of GEML §9.2 and of the profiles this parser checks. Each
// specification states every value once, in its table of fixed bounds; the
// parser, the viewer and the conformance suite's boundary cases
// (test/conformance/_bounds.mjs) all take them from here, and
// test/bounds.test.mjs holds this file to those tables.

/** `chain-depth`: links a transclusion chain, or a `view`'s `src=` chain, is followed (§9.3). */
export const CHAIN_DEPTH = 16;
/** `data-depth`: sequences and maps a `data` body's value tree nests (§3.2). */
export const DATA_DEPTH = 200;
/** `table-cells`: a table's or view's columns times its body rows, padded cells included (§6). */
export const TABLE_CELLS = 1_000_000;

// §9.2 leaves the nesting bounds to the implementation and asks for at least
// `nesting-floor` levels of each. These are this parser's.
/** Typed-block and list nesting. */
export const BLOCK_NESTING = 256;
/** Inline nesting: parseInline and scanAtoms recurse into each other. */
export const INLINE_NESTING = 100;

// §9.2 also lets a processor bound the cells one document reads into its
// relations from anywhere but its own text — each view's copy of its source,
// each data file a block reads — summed. `table-cells` bounds one relation;
// this bounds how many a few bytes of `=== view {src=#t}` can multiply it into.
/** Cells one document may borrow, summed over its relations. */
export const BORROWED_CELLS = 4_000_000;

/** geml-media/v1 `max-time`: seconds a time, or a cut's end on the timeline, may reach (§3.2). */
export const MEDIA_MAX_TIME = 86_400;
/** geml-media/v1 `apart-tolerance`: pixels two points an interaction only verifies may end up apart (§5.2). */
export const MEDIA_APART_PX = 2;
