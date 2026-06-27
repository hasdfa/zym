// GTK-backed regression tests for CompositeDisposable's controller helpers — the
// fix for the node-gtk controller-pin leak class (docs/lifecycle-and-disposal.md
// rule 9). These need real widgets, so they live apart from the pure eventKit
// tests. `observeControllers().nItems` is the only enumerable handle on a widget's
// controllers in this node-gtk build (cf. Picker.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Gtk from 'gi:Gtk-4.0';
import { CompositeDisposable } from './eventKit.ts';

Gtk.init();

const nControllers = (w: any): number => w.observeControllers().nItems as number;

test('addController attaches a real controller and dispose() removes it', () => {
  const widget = new Gtk.Box({});
  const cd = new CompositeDisposable();
  cd.addController(widget, new Gtk.GestureClick());
  assert.equal(nControllers(widget), 1, 'controller attached');
  cd.dispose();
  assert.equal(nControllers(widget), 0, 'controller removed on dispose — nothing left for node-gtk to pin');
});

test('a nested scope re-arms across cycles (the recycled-widget pattern)', () => {
  const widget = new Gtk.Box({});
  const owner = new CompositeDisposable();
  const scope = owner.nest();

  scope.addController(widget, new Gtk.EventControllerKey());
  assert.equal(nControllers(widget), 1);

  scope.clear(); // recycle: drop this cycle's controller, keep the scope usable
  assert.equal(nControllers(widget), 0);

  scope.addController(widget, new Gtk.EventControllerFocus());
  assert.equal(nControllers(widget), 1, 'scope re-armed for the next cycle');

  owner.dispose(); // end of life tears down the child scope too
  assert.equal(nControllers(widget), 0);
});

// The raw-signal-handler counterpart of the controller tests: `connect()` is the sever
// path EditorModel/Document/Transcript/the pickers/etc. now route their `.on(...)` handlers
// through (docs/lifecycle-and-disposal.md rule 2). node-gtk roots a connected handler's
// closure behind a Global handle, so `dispose()` MUST disconnect it. Asserted behaviorally
// (a value-changed counter) since this build can't enumerate a GObject's connected handlers.
test('connect attaches a GObject signal handler and dispose() disconnects it', () => {
  const adj = new Gtk.Adjustment({ value: 0, lower: 0, upper: 100, stepIncrement: 1 });
  const cd = new CompositeDisposable();
  let count = 0;
  cd.connect(adj, 'value-changed', () => { count++; });

  adj.setValue(10);
  assert.equal(count, 1, 'handler fires while connected');

  cd.dispose();
  adj.setValue(20);
  assert.equal(count, 1, 'handler disconnected on dispose — nothing left for node-gtk to pin');
});

test('a nested scope re-arms a signal handler across clear() cycles (the per-render bag)', () => {
  const adj = new Gtk.Adjustment({ value: 0, lower: 0, upper: 100, stepIncrement: 1 });
  const owner = new CompositeDisposable();
  const scope = owner.nest();
  let a = 0;
  let b = 0;

  scope.connect(adj, 'value-changed', () => { a++; });
  adj.setValue(1);
  assert.equal(a, 1);

  scope.clear(); // a render rebuild: drop the prior cycle's handler
  adj.setValue(2);
  assert.equal(a, 1, 'the previous cycle\'s handler no longer fires after clear()');

  scope.connect(adj, 'value-changed', () => { b++; });
  adj.setValue(3);
  assert.equal(b, 1, 'the new cycle\'s handler fires');

  owner.dispose();
  adj.setValue(4);
  assert.equal(b, 1, 'dispose tears down the child scope too');
});
