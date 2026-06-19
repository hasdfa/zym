// Vendored from xedel/vim-mode-plus's lib/global-state.js — ESM conversion. The
// VimState import (used only to refresh search highlights) is dropped to break
// the import cycle; the highlight-refresh side effect is restored when search
// lands. The lastSearchPattern→highlightSearchPattern auto-sync is kept.
import { Emitter, Disposable } from '../../../util/eventKit.ts'

// The shape of the global settings-like store. Several slots hold dynamic vim
// payloads (search patterns, registers, find state) that aren't modeled yet.
interface GlobalStateValues {
  searchHistory: string[]
  currentSearch: any // TODO(vim-ts): tighten — search-feature payload not ported
  lastSearchPattern: any // TODO(vim-ts): tighten — RegExp-like search pattern
  lastOccurrencePattern: any // TODO(vim-ts): tighten — occurrence pattern
  lastOccurrenceType: string | null
  highlightSearchPattern: any // TODO(vim-ts): tighten — RegExp-like search pattern
  currentFind: any // TODO(vim-ts): tighten — Find motion instance not ported
  register: Record<string, any> // TODO(vim-ts): tighten — register entries
  demoModeIsActive: boolean
  clipboardHistory: any[] // TODO(vim-ts): tighten — clipboard entries
}

type GlobalStateName = keyof GlobalStateValues

interface DidChangeEvent {
  name: GlobalStateName
  oldValue: GlobalStateValues[GlobalStateName]
  newValue: GlobalStateValues[GlobalStateName]
}

class GlobalState {
  state: GlobalStateValues
  emitter: Emitter

  constructor (state: GlobalStateValues) {
    this.state = state
    this.emitter = new Emitter()

    this.onDidChange(({name, newValue}: DidChangeEvent) => {
      if (name === 'lastSearchPattern') {
        // auto sync value, but highlightSearchPattern is solely cleared to clear hlsearch.
        this.set('highlightSearchPattern', newValue)
      }
      // 'highlightSearchPattern' → refresh per-editor highlightSearch: deferred
      // until the search feature is ported.
    })
  }

  get<K extends GlobalStateName> (name: K): GlobalStateValues[K] {
    return this.state[name]
  }

  set<K extends GlobalStateName> (name: K, newValue: GlobalStateValues[K]): void {
    const oldValue = this.get(name)
    this.state[name] = newValue
    this.emitDidChange({name, oldValue, newValue})
  }

  onDidChange (fn: (event: DidChangeEvent) => void): Disposable {
    return this.emitter.on('did-change', fn as (value?: unknown) => void)
  }

  emitDidChange (event: DidChangeEvent): void {
    this.emitter.emit('did-change', event)
  }

  reset (name?: GlobalStateName | null): void {
    const initialState = getInitialState()
    if (name != null) {
      this.set(name, initialState[name])
    } else {
      this.state = initialState
    }
  }
}

function getInitialState (): GlobalStateValues {
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
