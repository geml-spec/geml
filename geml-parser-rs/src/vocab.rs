//! Application-layer vocabularies (§8.6, `spec/profiles/`): the six this
//! processor recognizes, what each admits — block types with their body modes,
//! attribute keys per type, `=== meta` keys — and the diagnostic codes its
//! checks emit, with their default severities. A document is read under the
//! vocabularies its own `=== meta` declares and nothing else (§8.6.2 rule 2).

use crate::model::Mode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Draft,
    Stable,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Draft => "draft",
            State::Stable => "stable",
        }
    }
}

/// A profile diagnostic's severity: the core's two, and `info` — "a broken
/// structure is an error, a stale fact is a warning, a choice is info".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Error,
    Warning,
    Info,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warning => "warning",
            Level::Info => "info",
        }
    }
}

/// A vocabulary's diagnostic: reported by address (`doc#id`), not by line,
/// since a profile's facts are cross-document by nature.
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileDiagnostic {
    pub code: &'static str,
    pub level: Level,
    pub address: String,
    pub message: String,
}

impl Profile {
    /// The default severity this vocabulary assigns one of its codes.
    pub fn level_of(&self, code: &str) -> Option<Level> {
        self.codes.iter().find(|(c, _)| *c == code).map(|(_, l)| *l)
    }
}

pub struct Profile {
    pub name: &'static str,
    pub state: State,
    /// The types it admits, with the body each is read in.
    pub types: &'static [(&'static str, Mode)],
    /// Attribute keys it admits, per type (its own types or the core's).
    pub attrs: &'static [(&'static str, &'static [&'static str])],
    /// Types whose attribute space is open: any key passes the core check.
    pub open_attrs: &'static [&'static str],
    /// The `=== meta` keys it reads, or `None` when its meta is open.
    pub meta_keys: Option<&'static [&'static str]>,
    /// Every code its checks emit, with the default severity.
    pub codes: &'static [(&'static str, Level)],
}

impl Profile {
    /// The prefix a vocabulary owns: `geml-media/v1` owns `media-`.
    pub fn prefix(&self) -> String {
        let base = self.name.split('/').next().unwrap_or(self.name);
        format!("{}-", base.strip_prefix("geml-").unwrap_or(base))
    }
}

use Level::{Error as E, Info as I, Warning as W};
use Mode::{Flow, Prose, Raw};

pub const PROFILES: &[Profile] = &[
    Profile {
        name: "geml-codemap/v1",
        state: State::Stable,
        types: &[],
        attrs: &[("code", &["anchor", "name", "entry-via"])],
        open_attrs: &[],
        meta_keys: Some(&["module", "src", "entry", "resolution-default", "repo", "commit", "container", "graph-depth", "consts"]),
        codes: &[],
    },
    Profile {
        name: "geml-form/v1",
        state: State::Draft,
        types: &[("form", Flow), ("form-field", Raw), ("form-group", Flow), ("form-options", Raw), ("form-note", Raw)],
        attrs: &[
            ("form", &["handler"]),
            (
                "form-field",
                &[
                    "name",
                    "label",
                    "description",
                    "placeholder",
                    "type",
                    "required",
                    "multiple",
                    "value",
                    "options",
                    "pattern",
                    "min",
                    "max",
                    "step",
                    "maxlength",
                    "accept",
                ],
            ),
            ("form-group", &["label", "description", "required"]),
            ("form-options", &["format", "delim", "header", "src"]),
        ],
        open_attrs: &[],
        meta_keys: Some(&[]),
        // GEP-0008's structural rules, carried by the profile until the GEP
        // lands in the core (its §1.1): a `form-*` block is meaningful only
        // inside a `form`, and a field carries a `name=` no other field of its
        // form carries.
        codes: &[("form-child-outside-form", E), ("form-field-missing-name", E), ("form-duplicate-name", E)],
    },
    Profile {
        name: "geml-history/v1",
        state: State::Stable,
        types: &[("history-revision", Raw), ("history-keyframe", Raw), ("history-blob", Raw)],
        attrs: &[
            ("history-revision", &["id", "parent", "author", "summary", "hash", "newline"]),
            ("history-keyframe", &["id", "hash"]),
            ("history-blob", &["lang"]),
        ],
        open_attrs: &[],
        meta_keys: Some(&["history-of", "geml-version", "current", "keyframe-interval"]),
        codes: &[],
    },
    Profile {
        name: "geml-media/v1",
        state: State::Draft,
        types: &[
            ("media", Flow),
            ("media-asset", Raw),
            ("media-clip", Raw),
            ("media-text", Prose),
            ("media-comp", Flow),
            ("media-layer", Raw),
            ("media-interaction", Prose),
        ],
        attrs: &[
            ("media", &["tracks", "primary", "fps", "src", "in", "out", "duration"]),
            ("media-asset", &["src", "sha256", "kind", "duration", "fps", "size", "origin", "license", "mime", "of", "role", "points"]),
            (
                "media-clip",
                &[
                    "track",
                    "src",
                    "in",
                    "out",
                    "duration",
                    "over",
                    "offset",
                    "at",
                    "transition-in",
                    "transition-out",
                    "transition-duration",
                    "gain",
                    "fade-in",
                    "fade-out",
                    "speed",
                    "xywh",
                ],
            ),
            ("media-text", &["shot", "speaker", "to", "emotion", "since", "points"]),
            ("media-comp", &["shot", "size", "at"]),
            ("media-layer", &["src", "xywh", "w", "x", "y", "flip", "dx", "dy"]),
            ("media-interaction", &["a", "b", "kind"]),
        ],
        open_attrs: &[],
        meta_keys: Some(&["tracks", "primary", "fps", "aspect", "target-duration", "episode"]),
        codes: &[
            ("media-src-unresolved", E),
            ("media-src-not-asset", E),
            ("media-shape-ambiguous", E),
            ("media-shape-empty", E),
            ("media-clip-unassembled", E),
            ("media-duration-required", E),
            ("media-track-missing", E),
            ("media-track-kind-missing", E),
            ("media-track-kind-unknown", E),
            ("media-of-unresolved", E),
            ("media-speaker-unresolved", E),
            ("media-line-no-speaker", E),
            ("media-gen-schema", E),
            ("media-gen-output-not-asset", E),
            ("media-hash-mismatch", E),
            ("media-file-missing", W),
            ("media-asset-unhashed", W),
            ("media-track-undeclared", W),
            ("media-stale-generation", W),
            ("media-stale-clip", W),
            ("media-orphan-record", I),
            ("media-layer-unassembled", E),
            ("media-comp-size-missing", E),
            ("media-comp-empty", E),
            ("media-layer-not-image", E),
            ("media-interaction-unassembled", E),
            ("media-interaction-unresolved", E),
            ("media-interaction-point-undeclared", E),
            ("media-interaction-same-layer", E),
            ("media-layer-position-conflict", E),
            ("media-asset-size-required", E),
            ("media-comp-at-duplicate", E),
            ("media-interaction-apart", W),
        ],
    },
    Profile {
        name: "geml-style/v1",
        state: State::Draft,
        types: &[("style-rule", Raw), ("style-state", Raw), ("style-screen", Raw), ("style-frame", Raw)],
        attrs: &[],
        open_attrs: &["style-rule", "style-state", "style-screen", "style-frame"],
        meta_keys: None,
        codes: &[
            ("style-selector-unsupported", E),
            ("style-ambiguous-rule", W),
            ("style-unknown-state", E),
            ("style-unknown-screen", E),
            ("style-unknown-value-source", E),
            ("style-unknown-interaction", E),
            ("style-unknown-token", E),
            ("style-reserved-name", W),
            ("style-missing-attribute", E),
            ("style-unmatched-rule", W),
            ("style-unmatched-producer", W),
            ("style-unknown-component", W),
            ("style-unknown-handler", W),
            ("style-unknown-attribute", W),
            ("style-embed-not-expanded", W),
            ("style-unknown-frame", E),
            ("style-screen-nested", E),
            ("style-frame-cycle", E),
            ("style-frame-too-deep", E),
            ("style-unused-frame", W),
            ("style-invalid-value", E),
        ],
    },
    Profile {
        name: "geml-translator/v1",
        state: State::Draft,
        types: &[],
        attrs: &[("embed", &["translate-to"])],
        open_attrs: &[],
        meta_keys: Some(&["translate-to", "glossary", "source"]),
        codes: &[],
    },
];

pub fn builtin(name: &str) -> Option<&'static Profile> {
    PROFILES.iter().find(|p| p.name == name)
}

/// The vocabularies a document is read under: those its `profile` declares
/// that this processor recognizes.
#[derive(Default, Clone)]
pub struct Vocabulary {
    pub profiles: Vec<&'static Profile>,
}

impl Vocabulary {
    pub fn of(names: &[String], recognize: bool) -> Vocabulary {
        let mut profiles = Vec::new();
        if recognize {
            for n in names {
                if let Some(p) = builtin(n) {
                    if !profiles.iter().any(|q: &&Profile| q.name == p.name) {
                        profiles.push(p);
                    }
                }
            }
        }
        Vocabulary { profiles }
    }

    pub fn has(&self, name: &str) -> bool {
        self.profiles.iter().any(|p| p.name == name)
    }

    /// The body mode an admitted type is read in.
    pub fn mode_of(&self, t: &str) -> Option<Mode> {
        self.profiles.iter().flat_map(|p| p.types.iter()).find(|(n, _)| *n == t).map(|(_, m)| *m)
    }

    pub fn admits_type(&self, t: &str) -> bool {
        self.mode_of(t).is_some()
    }

    pub fn admits_attr(&self, t: &str, key: &str) -> bool {
        self.profiles.iter().any(|p| p.open_attrs.contains(&t) || p.attrs.iter().any(|(ty, keys)| *ty == t && keys.contains(&key)))
    }

    /// Whether a type is a prose type: an inline-projection target like `text`.
    pub fn is_prose(&self, t: &str) -> bool {
        self.mode_of(t) == Some(Mode::Prose)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry() {
        assert_eq!(builtin("geml-media/v1").unwrap().prefix(), "media-");
        assert_eq!(builtin("geml-codemap/v1").unwrap().prefix(), "codemap-");
        assert_eq!(builtin("geml-media/v1").unwrap().level_of("media-orphan-record"), Some(Level::Info));
        assert_eq!(builtin("geml-media/v1").unwrap().level_of("style-frame-cycle"), None);
        assert!(builtin("acme/v1").is_none());
        let v = Vocabulary::of(&["geml-media/v1".into(), "geml-media/v1".into(), "geml-style/v1".into(), "x/v1".into()], true);
        assert_eq!(v.profiles.len(), 2);
        assert!(v.has("geml-style/v1") && !v.has("geml-form/v1"));
        assert_eq!(v.mode_of("media-text"), Some(Mode::Prose));
        assert!(v.is_prose("media-interaction") && !v.is_prose("media"));
        assert!(v.admits_type("media-comp") && !v.admits_type("form"));
        assert!(v.admits_attr("media-layer", "dx") && v.admits_attr("style-rule", "anything") && !v.admits_attr("media-layer", "z"));
        assert!(Vocabulary::of(&["geml-media/v1".into()], false).profiles.is_empty());
        assert_eq!((State::Draft.as_str(), State::Stable.as_str()), ("draft", "stable"));
        assert_eq!((Level::Error.as_str(), Level::Warning.as_str(), Level::Info.as_str()), ("error", "warning", "info"));
        // Every profile code carries the vocabulary's prefix (README, *Naming*).
        for p in PROFILES {
            for (c, _) in p.codes {
                assert!(c.starts_with(&p.prefix()), "{c}");
            }
        }
    }
}
