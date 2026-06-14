// Vendored from xedel/vim-mode-plus's lib/global-state.js — ESM conversion. The
// VimState import (used only to refresh search highlights) is dropped to break
// the import cycle; the highlight-refresh side effect is restored when search
// lands. The lastSearchPattern→highlightSearchPattern auto-sync is kept.
import { Emitter } from '../../../util/eventKit.ts'

class GlobalState {
  constructor (state) {
    this.state = state
    this.emitter = new Emitter()

    this.onDidChange(({name, newValue}) => {
      if (name === 'lastSearchPattern') {
        // auto sync value, but highlightSearchPattern is solely cleared to clear hlsearch.
        this.set('highlightSearchPattern', newValue)
      }
      // 'highlightSearchPattern' → refresh per-editor highlightSearch: deferred
      // until the search feature is ported.
    })
  }

  get (name) {
    return this.state[name]
  }

  set (name, newValue) {
    const oldValue = this.get(name)
    this.state[name] = newValue
    this.emitDidChange({name, oldValue, newValue})
  }

  onDidChange (fn) {
    return this.emitter.on('did-change', fn)
  }

  emitDidChange (event) {
    this.emitter.emit('did-change', event)
  }

  reset (name) {
    const initialState = getInitialState()
    if (name != null) {
      this.set(name, initialState[name])
    } else {
      this.state = initialState
    }
  }
}

function getInitialState () {
  return {
    searchHistory: [],
    currentSearch: null,
    lastSearchPattern: null,
    lastOccurrencePattern: null,
    lastOccurrenceType: null,
    highlightSearchPattern: null,
    currentFind: null,
    register: {},
    demoModeIsActive: false,
    clipboardHistory: []
  }
}

export default new GlobalState(getInitialState())
