/*
 * BlockwiseSelection — stub.
 *
 * The full blockwise (visual-block / ctrl-v) machinery is a distinct feature
 * ported later. `swrap` references these static methods even for plain
 * character/linewise selections, so they report "no blockwise selections" and
 * stay out of the way. Constructing one (only reached via applyWise('blockwise'))
 * throws until the real implementation lands.
 */
export default class BlockwiseSelection {
  static has() {
    return false;
  }
  static getSelections() {
    return [];
  }
  static getLastSelection() {
    return undefined;
  }
  static getSelectionsOrderedByBufferPosition() {
    return [];
  }
  static clearSelections() {}

  constructor() {
    throw new Error('vim: blockwise (visual-block) selection not yet ported');
  }
}
