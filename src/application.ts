/*
 * Application lifecycle: owns the Adw.Application and the GLib main loop, and
 * builds the editor window when the application is activated.
 *
 * node-gtk needs both `gi.startLoop()` (to interleave GLib's loop with Node's
 * event loop) and an explicit GLib.MainLoop we run and quit ourselves.
 */
import { Adw, Gio, GLib, startLoop } from './gi.ts';
import { EditorWindow } from './editor-window.ts';

const APP_ID = 'com.github.romgrk.quilx';

export class Application {
  private readonly loop = GLib.MainLoop.new(null, false);
  private readonly app = new Adw.Application({
    applicationId: APP_ID,
    flags: Gio.ApplicationFlags.FLAGS_NONE,
  });
  private readonly initialFile: string;

  constructor(initialFile: string) {
    this.initialFile = initialFile;
    this.app.on('activate', () => this.onActivate());
  }

  /** Run the application; resolves to the process exit code. */
  run(): number {
    return this.app.run([]);
  }

  private onActivate() {
    new EditorWindow(this.app, () => this.quit(), this.initialFile);
    startLoop();
    this.loop.run();
  }

  private quit() {
    this.loop.quit();
    this.app.quit();
  }
}
