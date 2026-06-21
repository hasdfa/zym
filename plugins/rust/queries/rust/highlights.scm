; Rust highlights — authored for zym's capture palette (see `theme.syntax`;
; the highlighter does longest-prefix fallback, so unknown captures degrade
; gracefully). Compiles against tree-sitter-rust (bundled by tree-sitter-wasms).

; Identifiers
(identifier) @variable

; Constants — SCREAMING_SNAKE_CASE identifiers
((identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z\\d_]*$"))

; Types — UpperCamelCase identifiers + the dedicated type nodes
((identifier) @type
  (#match? @type "^_*[A-Z]"))
(type_identifier) @type
(primitive_type) @type.builtin

(field_identifier) @property
(shorthand_field_identifier) @property

; Functions
(function_item
  name: (identifier) @function)
(function_signature_item
  name: (identifier) @function)
(call_expression
  function: (identifier) @function)
(call_expression
  function: (field_expression
    field: (field_identifier) @function.method))
(call_expression
  function: (scoped_identifier
    name: (identifier) @function))
(generic_function
  function: (identifier) @function)
(generic_function
  function: (scoped_identifier
    name: (identifier) @function))

; Macros
(macro_invocation
  macro: (identifier) @function.macro
  "!" @function.macro)
(macro_definition
  name: (identifier) @function.macro)
(attribute
  (identifier) @function.macro)

; Parameters
(parameter
  pattern: (identifier) @variable.parameter)
(closure_parameters
  (identifier) @variable.parameter)

; Lifetimes
(lifetime
  (identifier) @label)

; Self
(self) @variable.special

; Literals
(boolean_literal) @boolean
(integer_literal) @number
(float_literal) @number
[
  (char_literal)
  (string_literal)
  (raw_string_literal)
] @string
(escape_sequence) @string.escape

; Comments
[
  (line_comment)
  (block_comment)
] @comment

; Punctuation
[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  "."
  ";"
  ":"
  "::"
  "->"
  "=>"
] @punctuation.delimiter

[
  "&"
  "*"
  "+"
  "-"
  "/"
  "%"
  "="
  "=="
  "!="
  "<"
  ">"
  "<="
  ">="
  "&&"
  "||"
  "!"
  "|"
  "^"
  "<<"
  ">>"
  "+="
  "-="
  "*="
  "/="
  "?"
  ".."
  "..="
] @operator

; Keywords
[
  "as"
  "async"
  "await"
  "break"
  "const"
  "continue"
  "default"
  "dyn"
  "else"
  "enum"
  "extern"
  "fn"
  "for"
  "if"
  "impl"
  "in"
  "let"
  "loop"
  "match"
  "mod"
  "move"
  "pub"
  "ref"
  "return"
  "static"
  "struct"
  "trait"
  "type"
  "union"
  "unsafe"
  "use"
  "where"
  "while"
] @keyword

(mutable_specifier) @keyword
(crate) @keyword
(super) @keyword
(use_declaration
  "use" @keyword.import)
