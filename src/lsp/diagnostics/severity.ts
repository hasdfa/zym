/*
 * Shared per-severity presentation for diagnostics: the Nerd Font glyph and the
 * severity color (which also strokes the inline squiggle). Used by both the
 * in-editor `DiagnosticsView` and the "Diagnostics" `DiagnosticsPanel`, so the
 * gutter, squiggle, and list stay in sync — this is the single source for
 * diagnostic icons no matter where they appear.
 *
 * Glyphs are Symbols Nerd Font Mono code points (bundled — see `fonts.ts`).
 * Error and warning share the codicon "warning" triangle (nf-cod-warning),
 * distinguished only by color; info and hint use info-circle and a lightbulb.
 */
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { theme } from '../../theme/theme.ts';

export interface SeverityStyle {
  glyph: string;
  color: string;
}

const COD_WARNING = String.fromCodePoint(0xea6c); // nf-cod-warning
const FA_INFO_CIRCLE = String.fromCodePoint(0xf05a);
const FA_LIGHTBULB = String.fromCodePoint(0xf0eb);

export const SEVERITY_STYLES: Record<number, SeverityStyle> = {
  [DiagnosticSeverity.Error]: { glyph: COD_WARNING, color: theme.ui.error },
  [DiagnosticSeverity.Warning]: { glyph: COD_WARNING, color: theme.ui.warning },
  [DiagnosticSeverity.Information]: { glyph: FA_INFO_CIRCLE, color: theme.ui.info },
  [DiagnosticSeverity.Hint]: { glyph: FA_LIGHTBULB, color: theme.ui.hint },
};

/** Presentation for a severity, defaulting to Error for unknown/undefined. */
export function severityStyle(value: number | undefined): SeverityStyle {
  return SEVERITY_STYLES[value ?? DiagnosticSeverity.Error] ?? SEVERITY_STYLES[DiagnosticSeverity.Error];
}
