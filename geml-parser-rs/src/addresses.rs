//! The addresses a listing gives (§4): block and heading ids, the prose
//! addresses derived from the two blocks around a stretch of prose, `#meta`.

use crate::model::{Block, Item};
use crate::uni::nfd;

pub struct Listing {
    /// Every address, `#`-prefixed, in document order.
    pub addresses: Vec<String>,
    /// The prose addresses alone, as the document's ids spell them.
    pub prose: Vec<String>,
}

enum Entry<'a> {
    Block(&'a Block),
    Heading(usize, std::ops::Range<usize>),
    /// A stretch of prose: the items it spans.
    Prose(std::ops::Range<usize>),
}

struct Ctx<'a> {
    meta_blocks: usize,
    shadowed: &'a dyn Fn(&str) -> bool,
    out: Listing,
    seen: Vec<String>,
    /// A prose address to find, and the stretch it names once found.
    want: Option<&'a str>,
    hit: Option<Vec<Item>>,
}

impl Ctx<'_> {
    fn push(&mut self, id: &str, prose: bool) {
        if id.is_empty() {
            return;
        }
        let key = nfd(id);
        if self.seen.contains(&key) {
            return;
        }
        self.seen.push(key);
        self.out.addresses.push(format!("#{id}"));
        if prose {
            self.out.prose.push(id.to_string());
        }
    }

    fn block_id(&self, b: &Block) -> Option<String> {
        match &b.id {
            Some(id) => Some(id.clone()),
            None if b.type_name == "meta" && self.meta_blocks == 1 => Some("meta".into()),
            None => None,
        }
    }
}

pub fn list(items: &[Item], meta_blocks: usize, shadowed: &dyn Fn(&str) -> bool) -> Listing {
    let mut cx = Ctx { meta_blocks, shadowed, out: Listing { addresses: vec![], prose: vec![] }, seen: vec![], want: None, hit: None };
    level(items, 0..items.len(), None, &mut cx);
    cx.out
}

/// The items of the stretch of prose a prose address names (§4): what an
/// `embed` of it takes.
pub fn prose_stretch(items: &[Item], meta_blocks: usize, address: &str) -> Option<Vec<Item>> {
    let none = |_: &str| false;
    let mut cx = Ctx { meta_blocks, shadowed: &none, out: Listing { addresses: vec![], prose: vec![] }, seen: vec![], want: Some(address), hit: None };
    level(items, 0..items.len(), None, &mut cx);
    cx.hit
}

/// One container's direct content: anchors (typed blocks, headings with
/// their sections) and the stretches of prose between them.
fn level(items: &[Item], range: std::ops::Range<usize>, container: Option<&str>, cx: &mut Ctx) {
    let mut entries: Vec<Entry> = Vec::new();
    let mut j = range.start;
    let mut prose_open = false;
    while j < range.end {
        match &items[j] {
            Item::Heading(h) => {
                let end = (j + 1..range.end).find(|k| matches!(&items[*k], Item::Heading(o) if o.level <= h.level)).unwrap_or(range.end);
                entries.push(Entry::Heading(j, j + 1..end));
                prose_open = false;
                j = end;
                continue;
            }
            Item::Block(b) => {
                entries.push(Entry::Block(b));
                prose_open = false;
            }
            Item::Paragraph(_) | Item::List(_) => {
                if prose_open {
                    if let Some(Entry::Prose(r)) = entries.last_mut() {
                        r.end = j + 1;
                    }
                } else {
                    entries.push(Entry::Prose(j..j + 1));
                    prose_open = true;
                }
            }
            Item::Hidden(_) => {}
        }
        j += 1;
    }
    let anchor_id = |e: &Entry, cx: &Ctx| -> Option<Option<String>> {
        match e {
            Entry::Block(b) => Some(cx.block_id(b)),
            Entry::Heading(h, _) => match &items[*h] {
                Item::Heading(h) => Some(Some(h.id.clone())),
                _ => None,
            },
            Entry::Prose(_) => None,
        }
    };
    for (k, e) in entries.iter().enumerate() {
        match e {
            Entry::Block(b) => {
                if let Some(id) = cx.block_id(b) {
                    cx.push(&id, false);
                }
                if b.mode == crate::model::Mode::Flow {
                    let id = b.id.clone();
                    level(&b.children, 0..b.children.len(), id.as_deref(), cx);
                }
            }
            Entry::Heading(h, sec) => {
                let id = match &items[*h] {
                    Item::Heading(x) => x.id.clone(),
                    _ => String::new(),
                };
                cx.push(&id, false);
                level(items, sec.clone(), if id.is_empty() { None } else { Some(&id) }, cx);
            }
            Entry::Prose(span) => {
                let p = if k > 0 { anchor_id(&entries[k - 1], cx) } else { None };
                let n = entries.get(k + 1).and_then(|x| anchor_id(x, cx));
                let addr = match (p, n) {
                    (Some(Some(p)), Some(Some(n))) => Some(format!("{p}-between-{n}")),
                    (None, Some(Some(n))) => container.map(|c| format!("{c}-before-{n}")),
                    (Some(Some(p)), None) => container.map(|c| format!("{c}-after-{p}")),
                    _ => None,
                };
                if let Some(a) = addr {
                    if cx.want == Some(a.as_str()) && cx.hit.is_none() {
                        cx.hit = Some(items[span.clone()].to_vec());
                    }
                    if !(cx.shadowed)(&a) {
                        cx.push(&a, true);
                    }
                }
            }
        }
    }
}
