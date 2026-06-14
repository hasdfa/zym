#!/usr/bin/env node
/*
 * quilx — a modal source-code editor built with GtkSourceView 5, GTK 4 and
 * Adwaita, on node-gtk.
 *
 * Features:
 *   - Vim-style modal editing (GtkSource.VimIMContext) with a status line
 *   - Syntax highlighting with language auto-detection
 *   - Adwaita light/dark style schemes that follow the system preference,
 *     plus a toolbar toggle to force dark mode
 *   - Open / Save / Save-As via the native Gtk.FileDialog
 *   - A source-map (minimap) gutter on the right
 *   - Keyboard shortcuts: Ctrl+O open, Ctrl+S save, Ctrl+Shift+S save-as,
 *     Ctrl+Q quit
 *
 * Run with:  pnpm start [file]   (or: node src/index.ts [file])
 *
 * Structure:
 *   gi.ts             node-gtk bootstrap + typed namespace exports
 *   application.ts    Adw.Application + main-loop lifecycle
 *   editor-window.ts  the editor window UI and file operations
 *   index.ts          this entry point
 */
import * as Path from 'node:path';
import { Application } from './application.ts';
import { preloadGrammars } from './syntax/grammar.ts';

// With no file argument, open the editor's own source.
const arg = process.argv[2];
const initialFile = arg ? Path.resolve(arg) : import.meta.filename;

// Load tree-sitter grammars before the GLib main loop starts — emscripten's
// async wasm init doesn't resolve once the loop is running.
await preloadGrammars();

process.exit(new Application(initialFile).run());
