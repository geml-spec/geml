//! `geml-form/v1`: GEP-0008's family diagnostics — the structural ones as
//! diagnostics of the parse, the rest reported by address — and the profile's
//! §5 value warning.

fn found(src: &str) -> Vec<String> {
    let d = geml::parse(&format!("=== meta\nprofile = \"geml-form/v1\"\n===\n\n{src}"));
    d.profile_diagnostics.iter().map(|x| format!("{}:{} {}", x.code, x.level.as_str(), x.address)).collect()
}

#[test]
fn a_well_formed_form_reports_nothing() {
    let src = "===== form {#contact handler=send}\n=== form-field {#email type=text label=#email-label required name=email}\n===\n\n==== form-group {#who label=Who description=\"About you\"}\n=== form-field {#role type=select options=#roles name=role}\n===\n====\n\n=== form-options {#roles format=csv}\nvalue, label\na, A\n===\n\n=== form-note {#email-label}\nYour **email**\n===\n=====\n";
    assert_eq!(found(src), Vec::<String>::new());
    // Undeclared, the same text runs no form checks.
    assert!(geml::parse(src).profile_diagnostics.is_empty());
}

#[test]
fn a_family_block_out_of_place() {
    let src = "=== form-field {#loose type=text name=loose}\n===\n\n=== form-note {#n}\nx\n===\n\n==== form {#f}\n=== form-group {#g}\n===\n====\n\n==== form-group {#outer}\n=== form-options {#deep}\na\n===\n====\n";
    // The structural rule is a diagnostic of the parse, one per misplaced block
    // (the parser's catalogue, not the address-keyed profile report).
    let d = geml::parse(&format!("=== meta\nprofile = \"geml-form/v1\"\n===\n\n{src}"));
    assert_eq!(geml::diagnostic_codes(&d).iter().filter(|c| *c == "form-child-outside-form:error").count(), 4);
    assert_eq!(found(src), Vec::<String>::new());
}

#[test]
fn a_field_that_points_at_the_wrong_block() {
    let src = "===== form {#f}\n=== form-field {name=colour type=colour}\nbody\n===\n\n=== form-field {#a options=#n label=#roles placeholder=#gone description=plain name=a}\n===\n\n=== form-field {#b options=roles name=b}\n===\n\n==== form-group {#g description=#roles}\n====\n\n=== form-options {#roles}\nx\n===\n\n=== form-note {#n}\nn\n===\n\n=== form-options {#spare}\nx\n===\n\n=== form-note\nanonymous\n===\n=====\n";
    assert_eq!(
        found(src),
        vec![
            // The form's own cross-checks, then each of its blocks.
            // A group's text is text, never a reference: `#g`'s description
            // names nothing, and `#roles` stays unused.
            "form-options-not-form-options:error document.geml#a",
            "form-note-not-form-note:error document.geml#a",
            "form-note-not-form-note:error document.geml#a",
            "form-options-not-form-options:error document.geml#b",
            "form-unused-block:warning document.geml#roles",
            "form-unused-block:warning document.geml#n",
            "form-unused-block:warning document.geml#spare",
            "form-unused-block:warning document.geml (line 31)",
            "form-field-has-body:warning document.geml (line 6)",
            "form-unknown-field-type:warning document.geml (line 6)",
        ]
    );
}

#[test]
fn names_are_required_and_unique_within_a_form() {
    let pre = "=== meta\nprofile = \"geml-form/v1\"\n===\n\n";
    let codes = |src: &str| geml::diagnostic_codes(&geml::parse(&format!("{pre}{src}")));
    assert_eq!(codes("==== form {#f}\n=== form-field {label=Email}\n===\n====\n"), vec!["form-field-missing-name:error"]);
    assert_eq!(codes("==== form {#f}\n=== form-field {name=\"\" label=Email}\n===\n====\n"), vec!["form-field-missing-name:error"]);
    assert_eq!(codes("==== form {#f}\n=== form-field {name=3}\n===\n====\n"), vec!["form-field-missing-name:error"], "a name is a string");
    // Unique within the form; a group adds no namespace; another form may reuse it.
    let d = geml::parse(&format!("{pre}===== form {{#f}}\n=== form-field {{name=email}}\n===\n==== form-group {{#g}}\n=== form-field {{name=email}}\n===\n====\n=====\n\n==== form {{#h}}\n=== form-field {{name=email}}\n===\n====\n"));
    assert_eq!(geml::diagnostic_codes(&d), vec!["form-duplicate-name:error"]);
    assert_eq!(d.diagnostics[0].line, 9, "reported on the later field");
    // A stray field is only out of place; its name is checked once it is in a form.
    assert_eq!(codes("=== form-field {label=x}\n===\n"), vec!["form-child-outside-form:error"]);
    // Undeclared, the family is not read and nothing is checked.
    assert_eq!(geml::diagnostic_codes(&geml::parse("==== form {#f}\n=== form-field {label=x}\n===\n====\n")), vec!["unknown-block-type:warning"]);
}

#[test]
fn a_field_is_addressed_by_its_name() {
    let pre = "=== meta\nprofile = \"geml-form/v1\"\n===\n\n";
    let form = "===== form {#signup}\n=== form-field {name=email label=\"Email address\" type=text}\n===\n=== form-field {name=bare type=text}\n===\n==== form-group {#contacts}\n=== form-field {name=role label=Role type=text}\n===\n====\n=====\n\n";
    // On the form or on the group, by a quoted string or a bare word; what a
    // reference says is the field's label, or its name when it has none.
    let d = geml::parse(&format!("{pre}{form}See [[#signup[\"email\"]]], [[#signup[\"role\"]]], [[#contacts[role]]] and [[#signup[\"bare\"]]].\n"));
    assert_eq!(geml::diagnostic_codes(&d), Vec::<String>::new());
    let p = geml::project(&d);
    for want in [
        r##"ref("#signup[\"email\"]" -> "Email address")"##,
        r##"ref("#signup[\"role\"]" -> "Role")"##,
        r##"ref("#contacts[role]" -> "Role")"##,
        r##"ref("#signup[\"bare\"]" -> "bare")"##,
    ] {
        assert!(p.contains(want), "{want}\n{p}");
    }
    // Refused: a position, a name no field carries, a step under a field, a
    // projection and an embed — a field is a control, not content.
    let d = geml::parse(&format!(
        "{pre}{form}[[#signup[1]]] [[#signup[\"nope\"]]] [[#signup[\"email\"][\"x\"]]] ![[#signup[\"email\"]]]\n\n=== embed {{src=#signup[email]}}\n===\n"
    ));
    let mut c = geml::diagnostic_codes(&d);
    c.sort();
    assert_eq!(
        c,
        vec![
            "embed-target-not-projectable:error",
            "inline-transclusion-not-inline:error",
            "unresolved-reference:error",
            "unresolved-reference:error",
            "unresolved-reference:error"
        ]
    );
    let m: Vec<&str> = d.diagnostics.iter().map(|x| x.message.as_str()).collect();
    assert!(m.iter().any(|x| x.contains("not by position")), "{m:?}");
    assert!(m.iter().any(|x| x.contains("no field named `nope`; its fields are `email`, `bare`, `role`")), "{m:?}");
    assert!(m.iter().any(|x| x.contains("no units inside it")), "{m:?}");
    assert!(m.iter().any(|x| x.contains("a control, not content; reference it with `[[…]]`, which says its label")), "{m:?}");
    // Undeclared, a `form` is an unknown type with a raw body: no fields.
    let d = geml::parse(&format!("{form}[[#signup[\"email\"]]]\n"));
    assert!(geml::diagnostic_codes(&d).contains(&"unresolved-reference:error".to_string()));
    assert!(d.diagnostics.iter().any(|x| x.message.contains("is `geml-form/v1` declared?")));
}

#[test]
fn a_constraint_value_is_read_never_evaluated() {
    let form = |fields: &[&str]| {
        let body: String = fields.iter().map(|a| format!("=== form-field {{{a}}}\n===\n")).collect();
        found(&format!("==== form {{#f}}\n{body}====\n"))
    };
    // Readable: a number written as a string, a leap day, a zero length, a
    // pattern only the `u` flag reads, lookaround and a backreference; `min=`
    // on a type it does not fit is not judged, and a value below `min=` is the
    // handler's business.
    assert_eq!(
        form(&[
            "name=a type=number min=\"5\" max=1e3 step=\"+.5\" maxlength=\"-0\" value=-5",
            "name=b type=date min=2024-02-29 max=2000-02-29",
            "name=c type=text maxlength=0 pattern=\"^\\p{L}+$\"",
            "name=d type=text pattern=\"(?<=a)(b)(?=c)\\1\"",
            "name=e type=boolean min=abc max=[1]",
        ]),
        Vec::<String>::new()
    );
    // Unreadable, one warning each: a 29 February of a common year, a
    // thirteenth month, a date without its dashes, a flag, an overflow, a
    // negative step, a fractional length, a flag pattern, an unknown property,
    // a misplaced dash, a non-digit year, and two half-written numbers.
    let got = form(&[
        "name=a type=date min=2023-02-29 max=1900-02-29",
        "name=b type=date min=2024-13-01 max=20240101",
        "name=c type=number min max=1e999 step=-1 maxlength=1.5",
        "name=d type=text pattern",
        "name=e type=text pattern=\"\\p{Nope}\"",
        "name=f type=date min=2024-1-001 max=x024-01-01",
        "name=g type=number min=\"1.\" max=\".5e\"",
    ]);
    assert_eq!(got.len(), 14, "{got:#?}");
    assert!(got.iter().all(|x| x.starts_with("form-constraint-unreadable:warning")));
}

#[test]
fn a_flag_is_neither_a_type_nor_a_list() {
    assert_eq!(
        found("==== form {#f}\n=== form-field {name=a type}\n===\n=== form-field {name=b options}\n===\n=== form-field {name=c options=5}\n===\n====\n"),
        vec![
            "form-options-not-form-options:error document.geml (line 8)",
            "form-options-not-form-options:error document.geml (line 10)",
            "form-unknown-field-type:warning document.geml (line 6)",
        ]
    );
}
