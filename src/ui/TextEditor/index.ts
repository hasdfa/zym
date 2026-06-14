/*
 * TextEditor — public entry for the editor widget package.
 *
 * The editor's complexity (the GtkSource view/buffer, tree-sitter syntax, and —
 * in progress — the custom vim modal layer ported from vim-mode-plus) is
 * isolated under this directory. Consumers import from here, not from the
 * internal modules.
 */
export { TextEditor, type TextEditorOptions } from './TextEditor.ts';
