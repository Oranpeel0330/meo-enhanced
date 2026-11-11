# HTML compatibility

Live and ordinary Preview share their HTML content policy in
`src/shared/htmlPolicy.ts` and CSS validation in `src/shared/htmlStyle.ts`.
Their DOM, typography and editing controls remain surface-owned. Switching
surfaces must not turn supported HTML into source or discard its content.
The compatibility reference is VS Code's built-in Markdown Preview with its
default security settings, for common static document content.

The GitHub README preset keeps its separate, captured GitHub compatibility
policy. Extending ordinary HTML must not widen that preset's tag, attribute,
style or resource policy.

## Content

Supported content includes document structure and text semantics, lists,
disclosures, tables and column/cell attributes, pictures and image candidates,
native audio/video controls, ordinary form controls, static SVG and MathML,
open non-modal dialogs, legacy font/list/table presentation and inert custom tags.
The exported tag and attribute sets are the authoritative catalog used by
source assistance and both renderers. Generic `class`, `aria-*` and `data-*`
attributes are supported; editor-owned classes, IDs and source/resource markers
remain reserved. Native control values are temporary presentation state, not
edits to the Markdown. Form submission is prevented.

Within a mounted Live HTML block, unrelated source edits retain unchanged
pictures, responsive images, media playback, form values and nested disclosure
state. Changed or removed resources use the existing resolution/disposal owners.
Source-bound controls receive current callbacks and coordinates. External document
replacement invalidates the old HTML editing range, including equal-text reloads;
the new document's syntax determines any remaining source presentation.

Unknown tags inside a supported fragment are shown as escaped markup without
discarding supported siblings or children. Unsupported standalone fragments
retain their source. Script elements and event attributes never execute.
Frame/object embedding, active SVG content and executable document behavior
are outside this policy.

CommonMark still owns HTML/Markdown boundaries: continuous block HTML keeps
Markdown punctuation literal; blank lines can return content to Markdown
parsing. Inline HTML participates in inline Markdown. MEO retains its existing
literal HTML `code` rule. Source, selections and history always refer to the
original Markdown, never serialized rendered DOM.

An explicit root closing tag also bounds a fragment whose children omit end
tags. Live and Preview let their existing native parsing and sanitization repair
that interior for presentation; the source is not rewritten. Fragment discovery
does not infer a missing root end from EOF, later siblings, comments or literal
code examples. Tag input assistance still requires explicit pairs before reusing
an existing closing tag.

## Styles and resources

See [inline styles](html-inline-styles.md) for the declaration policy. Document
`style` elements use the same declaration validation. Selectors are scoped to
the reading document, excluding exposed HTML source, preview labels and editor
controls. Conditional `media`, `supports`, `container`, `layer` and `scope` rules
are retained. Static formatting includes transforms, filters, clipping/overflow,
vertical writing, pseudo-element content and important declarations.

Document `<link rel="stylesheet" href="effects.css">` and CSS imports load local,
HTTPS and applicable data resources through the shared stylesheet resource owner.
The link resolves from the Markdown file; imports, images and fonts resolve from
the stylesheet containing them. Chinese names, spaces, nested imports, media/layer
conditions and import cycles are covered. Local HTML/DOCX assets are embedded;
PDF uses its existing file-resource pipeline. Author font faces receive private
family names so they cannot replace workbench fonts. New stylesheet resources
follow the default secure-content policy; existing HTTP image/media handling is
independent. Scripts, events and executable CSS remain filtered.
Saving a CSS document in VS Code refreshes dependent author styles through the
existing save notification. Obsolete replies cannot overwrite newer styles.

Author HTML, including inline fragments and their children, retains the browser's
native box sizing on both surfaces, including native control defaults. Reader
layout resets do not reinterpret an author's width, height and padding. Explicit inline, document stylesheet and
preset rules can still choose another box model. Fonts, line spacing and heading
colors continue to follow the surface or selected preset.

Live owns one derived stylesheet per surface. Optimized documents collect it
in the existing Markdown context worker and retain it through proven plain-text
projections. Preview carries it in its existing presentation styles. Styles do
not depend on whether the source block is currently mounted, and author styles
cannot select the surrounding toolbar or workbench.

Pictures keep native `source`/`img` structure. Pictures and media reuse the
existing resource resolver and surface cancellation/geometry lifecycle. Removed
Live media stop loading/playing; aborted pending Preview resources retain their
source markers for the next presentation. Local export resources use the
ordinary asset pipeline. HTML/PDF/DOCX share content filtering, while format
capabilities can differ (for example, native media and advanced CSS in Word).

## Verification

`bun scripts/test-html-content.ts --styles-only` covers the shared policy and
production Live, Preview and Source side Preview in ordinary and optimized
documents, including computed grid/flex/CSS-variable styles, SVG/MathML,
controls, pictures, external stylesheet resources, actual font loading, stale
stylesheet replies, CommonMark containers, source preservation and unchanged
node identity. `scripts/test-html-content.ts` also owns HTML editing, selection,
history and mode transitions. `scripts/test-github-readme-compatibility.ts`
retains the independent GitHub reference corpus.

`bun scripts/test-vscode-html-compatibility.ts --code <Code executable>` compares
26 static HTML/CSS witnesses with the installed built-in Markdown Preview under
default security. Font namespacing, embedded assets and MEO's documented literal
HTML-code rule are checked explicitly. It uses a disposable profile and records
the VS Code version and per-case result.
