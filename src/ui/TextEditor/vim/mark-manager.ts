// Vendored from xedel/vim-mode-plus's lib/mark-manager.js — ESM conversion only.
import { Point } from '../../../text/Point.ts'
import type { PointLike } from '../../../text/Point.ts'
import type VimState from './vim-state.ts'
import type { Marker } from '../Marker.ts'
import type { MarkerLayer } from '../MarkerLayer.ts'

const MARKS_REGEX = /[a-z]|[[\]`'.^(){}<>]/

class MarkManager {
  vimState: VimState
  marks: Record<string, Marker> | null
  markerLayer: MarkerLayer

  constructor (vimState: VimState) {
    this.vimState = vimState
    vimState.onDidDestroy(() => this.destroy())
    this.marks = {}
    this.markerLayer = vimState.editor.addMarkerLayer()
  }

  destroy (): void {
    this.markerLayer.destroy()
    this.marks = null
  }

  isValid (name: string): boolean {
    return MARKS_REGEX.test(name)
  }

  get (name: string): Point | undefined {
    if (!this.isValid(name)) return

    const mark = this.marks![name]
    if (mark) {
      return mark.getStartBufferPosition()
    } else if (['`', "'"].includes(name)) {
      return Point.ZERO
    }
  }

  // [FIXME] Need to support Global mark with capital name [A-Z]
  set (name: string, point: PointLike): void {
    if (!this.isValid(name)) return

    const marker = this.marks![name]
    if (marker) marker.destroy()

    const {editor} = this.vimState
    point = editor.clipBufferPosition(point)
    // TODO(vim-ts): tighten — MarkerLayer.markBufferPosition doesn't model the
    // {invalidate} options arg yet; the extra runtime arg is preserved.
    this.marks![name] = (this.markerLayer.markBufferPosition as any)(point, {invalidate: 'never'})
    this.vimState.emitter.emit('did-set-mark', {name, bufferPosition: point, editor})
  }
}

export default MarkManager
