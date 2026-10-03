//! `geml-form/v1`: GEP-0008's family diagnostics — the structural one as a
//! diagnostic of the parse, the rest reported by address.

fn found(src: &str) -> Vec<String> {
    let d = geml::parse(&format!("=== meta\nprofile = \"geml-form/v1\"\n===\n\n{src}"));
    d.profile_diagnostics.iter().map(|x| format!("{}:{} {}", x.code, x.level.as_str(), x.address)).collect()
}

#[test]
fn a_well_formed_form_reports_nothing() {
    let src = "===== form {#contact handler=send}\n=== form-field {#email type=text label=#email-label required name=email}\n===\n\n==== form-group {#who label=Who description=#who-note}\n=== form-field {#role type=select options=#roles name=role}\n===\n====\n\n=== form-options {#roles format=csv}\nvalue, label\na, A\n===\n\n=== form-note {#email-label}\nYour **email**\n===\n\n=== form-note {#who-note}\nAbout you\n===\n=====\n";
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
            "options-not-form-options:error document.geml#a",
            "note-not-form-note:error document.geml#a",
            "note-not-form-note:error document.geml#a",
            "options-not-form-options:error document.geml#b",
            "note-not-form-note:error document.geml#g",
            "unused-form-block:warning document.geml#roles",
            "unused-form-block:warning document.geml#n",
            "unused-form-block:warning document.geml#spare",
            "unused-form-block:warning document.geml (line 31)",
            "form-field-has-body:warning document.geml (line 6)",
            "unknown-field-type:warning document.geml (line 6)",
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
