; Vendored verbatim from tree-sitter/tree-sitter-typescript @ v0.20.5
;   https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.20.5/queries/highlights.scm
; These are TypeScript-only additions; the loader concatenates them after the
; JavaScript query (TS/TSX grammars are supersets). Pinned to match the bundled
; grammar version (see grammar.ts). Only this header is local.

; Types

(type_identifier) @type
(predefined_type) @type.builtin

((identifier) @type
 (#match? @type "^[A-Z]"))

(type_arguments
  "<" @punctuation.bracket
  ">" @punctuation.bracket)

; Variables

(required_parameter (identifier) @variable.parameter)
(optional_parameter (identifier) @variable.parameter)

; Keywords

[ "abstract"
  "declare"
  "enum"
  "export"
  "implements"
  "interface"
  "keyof"
  "namespace"
  "private"
  "protected"
  "public"
  "type"
  "readonly"
  "override"
  "satisfies"
] @keyword
