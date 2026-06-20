; Foldable nodes — block constructs + multi-line comments. (Consecutive
; import/comment runs are folded separately by the editor.)
[
  (statement_block)
  (object)
  (array)
  (class_body)
  (switch_body)
  (named_imports)
  (arguments)
  (interface_body)
  (enum_body)
  (object_type)
  (comment)
] @fold

; --- keep-footer: chained constructs whose closing line continues (`} else {`,
; --- `} catch {`, `} finally {`). Captured separately so the fold keeps that line
; --- on its own line instead of joining it onto the header. See folding.md.
(if_statement
  consequence: (statement_block) @fold.keepFooter
  alternative: (_))
(try_statement body: (statement_block) @fold.keepFooter handler: (catch_clause))
(try_statement body: (statement_block) @fold.keepFooter finalizer: (finally_clause))
(try_statement
  handler: (catch_clause body: (statement_block) @fold.keepFooter)
  finalizer: (finally_clause))
