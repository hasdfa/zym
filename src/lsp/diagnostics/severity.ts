/*
 * Shared per-severity presentation for diagnostics: the Nerd Font glyph and the
 * severity color (which also strokes the inline squiggle). Used by both the
 * in-editor `DiagnosticsView` and the "Diagnostics" `DiagnosticsPanel`, so the
 * gutter, squiggle, and list stay in sync — this is the single source for
 * diagnostic icons no matter where they appear.
 *
 * Glyphs are Symbols Nerd Font Mono code points (bundled — see `fonts.ts`).
 * Error and warning share the warning triangle, distinguished only by color;
 * info and hint use info-circle and a lightbulb.
 */
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { theme } from '../../theme/theme.ts';
import { NERDFONT } from '../../ui/nerdfont.ts';

export interface SeverityStyle {
  glyph: string;
  color: string;
}

export const SEVERITY_STYLES: Record<number, SeverityStyle> = {
  [DiagnosticSeverity.Error]: { glyph: NERDFONT.STATUS.WARNING, color: theme.ui.status.error },
  [DiagnosticSeverity.Warning]: { glyph: NERDFONT.STATUS.WARNING, color: theme.ui.status.warning },
  [DiagnosticSeverity.Information]: { glyph: NERDFONT.STATUS.INFO, color: theme.ui.status.info },
  [DiagnosticSeverity.Hint]: { glyph: NERDFONT.STATUS.HINT, color: theme.ui.status.hint },
};

/** Presentation for a severity, defaulting to Error for unknown/undefined. */
export function severityStyle(value: number | undefined): SeverityStyle {
  return SEVERITY_STYLES[value ?? DiagnosticSeverity.Error] ?? SEVERITY_STYLES[DiagnosticSeverity.Error];
}
