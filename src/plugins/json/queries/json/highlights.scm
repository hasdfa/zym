; JSON highlights — authored for quilx's capture palette (see `theme.syntax`;
; the highlighter does longest-prefix fallback, so unknown captures degrade
; gracefully). Compiles against tree-sitter-json (bundled by tree-sitter-wasms).

; Object keys — captured as @property. `property` outranks `string` in the
; theme's capture priority, so a key (also matched by the generic `(string)`
; rule below) wins the property color.
(pair
  key: (string) @property)

; Strings (values) + their escapes
(string) @string
(escape_sequence) @string.escape

; Numbers
(number) @number

; Literals
[
  (true)
  (false)
] @boolean
(null) @constant.builtin

; Comments (jsonc / json-with-comments)
(comment) @comment

; Punctuation
[
  "{"
  "}"
  "["
  "]"
] @punctuation.bracket

[
  ","
  ":"
] @punctuation.delimiter
