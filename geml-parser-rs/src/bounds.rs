//! The fixed bounds of GEML §9.2 and of the profiles this crate checks. Each
//! specification states every value once, in its table of fixed bounds, and
//! `tests/bounds.rs` holds these constants to those tables.

/// `chain-depth`: links a transclusion chain, or a `view`'s `src=` chain, is followed (§9.3).
pub const CHAIN_DEPTH: usize = 16;
/// `data-depth`: sequences and maps a `data` body's value tree nests (§3.2).
pub const DATA_DEPTH: usize = 200;
/// `table-cells`: a table's or view's columns times its body rows, padded cells included (§6).
pub const TABLE_CELLS: usize = 1_000_000;

// §9.2 leaves the nesting bounds to the implementation and asks for at least
// `nesting-floor` levels of each. These are this crate's.
/// Typed-block nesting, and list nesting.
pub const BLOCK_NESTING: usize = 256;
/// Inline nesting, counted through every kind of inline node — emphasis, links and images alike.
pub const INLINE_NESTING: usize = 100;
/// Cells one document may read into its relations from anywhere but its own
/// text — each view's copy of its source, each data file a block reads —
/// summed (§9.2 lets a processor bound them, as the reference does at the same
/// number). `TABLE_CELLS` bounds one relation; this bounds how many a few bytes
/// of `=== view {src=#t}` can multiply it into.
pub const BORROWED_CELLS: usize = 4_000_000;
/// Expansions one stylesheet load or one prompt spends in all (§9.3 lets a
/// processor bound the work, as the reference does at the same number): the
/// depth bound alone lets K embeds of one target nest into K^16.
pub const EMBED_TOTAL: usize = 1000;

/// geml-media/v1 `max-time`: seconds a time, or a cut's end on the timeline, may reach (§3.2).
pub const MEDIA_MAX_TIME: f64 = 86_400.0;
/// geml-media/v1 `apart-tolerance`: pixels two points an interaction only verifies may end up apart (§5.2).
pub const MEDIA_APART_PX: f64 = 2.0;
