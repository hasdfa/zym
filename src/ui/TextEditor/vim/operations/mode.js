/*
 * Mode operations not yet covered by a vendored module.
 *
 * `ActivateInsertMode` and `InsertAfter` come from the vendored
 * `operator-insert.js`. `ActivateNormalMode` lives in upstream's
 * `misc-command.js` (not vendored yet), so a minimal quilx version is provided
 * here until that file lands; it self-registers on import.
 */
import { Base } from '../base.js'

class ActivateNormalMode extends Base {
  static operationKind = 'misc-command'
  execute() {
    this.vimState.activate('normal')
  }
}
ActivateNormalMode.register()

// Visual-mode activation. Upstream registers these as plain command handlers in
// main.js (not Base classes); here they are small operations so they flow through
// the operation stack like the other mode changes. Re-activating the current wise
// toggles back to normal (handled inside vimState.activate).
class ActivateCharacterwiseVisualMode extends Base {
  static operationKind = 'misc-command'
  execute() {
    this.vimState.activate('visual', 'characterwise')
  }
}
ActivateCharacterwiseVisualMode.register()

class ActivateLinewiseVisualMode extends Base {
  static operationKind = 'misc-command'
  execute() {
    this.vimState.activate('visual', 'linewise')
  }
}
ActivateLinewiseVisualMode.register()

class ActivateBlockwiseVisualMode extends Base {
  static operationKind = 'misc-command'
  execute() {
    this.vimState.activate('visual', 'blockwise')
  }
}
ActivateBlockwiseVisualMode.register()

export {
  ActivateNormalMode,
  ActivateCharacterwiseVisualMode,
  ActivateLinewiseVisualMode,
  ActivateBlockwiseVisualMode,
}
