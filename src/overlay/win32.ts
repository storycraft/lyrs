import EventEmitter from 'node:events';

import {
  defaultDllDir,
  length,
  Overlay,
  percent,
  PercentLength,
} from 'asdf-overlay-node';
import { NativeImage, TextureInfo } from 'electron';
import hmc from 'hmc-win32';
import * as wql from '@jellybrick/wql-process-monitor';
import { AsyncReturnType } from 'type-fest';

import { AttachedOverlay, OverlayFactory } from '.';
import { ProcessInfo, ProcMonitor, ProcMonitorEventEmitter } from './monitor';

import { LyricWindowProvider } from '../window/lyric';
import { config, themeList } from '../config';
import {
  DEFAULT_CONFIG,
  DEFAULT_STYLE,
  PRESET_PREFIX,
} from '../../common/constants';
import presetThemes from '../../common/presets';

export class Win32OverlayFactory implements OverlayFactory {
  private corsCallback?: (webContents: Electron.WebContents) => void;

  applyCorsCallback(
    callback: (webContents: Electron.WebContents) => void,
  ): void {
    this.corsCallback = callback;
  }

  async create(pid: number, viewIndex: number): Promise<AttachedOverlay> {
    const overlay = await Overlay.attach(
      // electron asar path fix
      defaultDllDir().replace('app.asar', 'app.asar.unpacked'),
      pid,
      5000,
    );

    return await Win32AttachedOverlay.initialize(
      viewIndex,
      overlay,
      this.corsCallback,
    );
  }
}

class Win32AttachedOverlay implements AttachedOverlay {
  private readonly provider: LyricWindowProvider;
  private readonly configWatcher: () => void;

  private closed = false;
  private constructor(
    private viewIndex: number,
    private readonly overlay: Overlay,
    private readonly hwnd: number,
    corsCallback?: (webContents: Electron.WebContents) => void,
  ) {
    this.provider = new LyricWindowProvider(viewIndex, {
      force: true,
      webPreferences: {
        offscreen: {
          useSharedTexture: true,
        },
      },
    });
    overlay.event.on('destroyed', () => {
      this.closed = true;
      config.unwatch(this.configWatcher);
      this.provider.close();
    });
    const webContents = this.provider.window.webContents;
    webContents.on('paint', (e, __, image: Electron.NativeImage) => {
      this.updateSurface(image, e.texture?.textureInfo).finally(() => {
        e.texture?.release();
      });
    });
    webContents.invalidate();
    corsCallback?.(this.provider.window.webContents);

    overlay.event.on('cursor_input', (_, input) => {
      if (input.kind !== 'Move') {
        return;
      }

      webContents.sendInputEvent({
        type: 'mouseMove',
        x: input.clientX,
        y: input.clientY,
        globalX: input.windowX,
        globalY: input.windowY,
      });
    });
    // Listen mouse input
    overlay.listenInput(hwnd, true, false);

    this.configWatcher = () => {
      this.updatePosition();
      this.provider.updateWindowConfig();
    };

    config.watch(this.configWatcher);
  }

  async updateViewIndex(index: number) {
    this.viewIndex = index;
    this.provider.setIndex(index, true);
    await this.updatePosition();
  }

  private async updatePosition() {
    const view =
      config.get().views[this.viewIndex] ?? DEFAULT_CONFIG.views[0].position;
    const position = view.position;
    const themes = themeList.get();
    let style;
    if (view.theme.startsWith(PRESET_PREFIX)) {
      const name = view.theme.replace(PRESET_PREFIX, '');
      style = presetThemes[name] ?? DEFAULT_STYLE;
    } else {
      style = themes[view.theme] ?? DEFAULT_STYLE;
    }

    let anchor: [PercentLength, PercentLength];
    switch (position.anchor) {
      case 'left': {
        anchor = [percent(0), percent(0.5)];
        break;
      }

      case 'right': {
        anchor = [percent(1), percent(0.5)];
        break;
      }

      case 'top': {
        anchor = [percent(0.5), percent(0)];
        break;
      }

      case 'top-left': {
        anchor = [percent(0), percent(0)];
        break;
      }

      case 'top-right': {
        anchor = [percent(1), percent(0)];
        break;
      }

      case 'center': {
        anchor = [percent(0.5), percent(0.5)];
        break;
      }

      case 'bottom': {
        anchor = [percent(0.5), percent(1)];
        break;
      }

      case 'bottom-left': {
        anchor = [percent(0), percent(1)];
        break;
      }

      case 'bottom-right':
      default: {
        anchor = [percent(1), percent(1)];
        break;
      }
    }

    try {
      await this.overlay.setPosition(this.hwnd, anchor[0], anchor[1]);
      await this.overlay.setAnchor(this.hwnd, anchor[0], anchor[1]);
      await this.overlay.setMargin(
        this.hwnd,
        length(position.top + style.position.top),
        length(position.right + style.position.right),
        length(position.bottom + style.position.bottom),
        length(position.left + style.position.left),
      );
    } catch (e) {
      console.error('[Lyrs] error while updating overlay position', e);
    }
  }

  sendEvent(event: string, ...args: unknown[]) {
    this.provider.window.webContents.send(event, ...args);
  }

  private async updateSurface(
    bitmap: NativeImage,
    sharedTexture?: TextureInfo,
  ) {
    try {
      if (sharedTexture) {
        const rect =
          sharedTexture.metadata.captureUpdateRect ?? sharedTexture.contentRect;

        // update only changed part
        await this.overlay.updateShtex(
          this.hwnd,
          sharedTexture.codedSize.width,
          sharedTexture.codedSize.height,
          sharedTexture.sharedTextureHandle,
          {
            dstX: rect.x,
            dstY: rect.y,
            src: rect,
          },
        );
      }
      return true;
    } catch (e) {
      console.warn('[Lyrs] failed update overlay using shared surface', e);
    }

    try {
      await this.overlay.updateBitmap(
        this.hwnd,
        bitmap.getSize().width,
        bitmap.toBitmap(),
      );
    } catch (e) {
      console.error('[Lyrs] error while updating overlay', e);
      throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.overlay.destroy();
  }

  static async initialize(
    viewIndex: number,
    overlay: Overlay,
    corsCallback?: (webContents: Electron.WebContents) => void,
  ): Promise<Win32AttachedOverlay> {
    // wait for main window
    const hwnd = await new Promise<number>((resolve) =>
      overlay.event.once('added', resolve),
    );

    const instance = new Win32AttachedOverlay(
      viewIndex,
      overlay,
      hwnd,
      corsCallback,
    );

    try {
      await instance.updatePosition();
    } catch (e) {
      instance.close();
      throw e;
    }

    return instance;
  }
}

type MonitorEmittery = AsyncReturnType<typeof wql.promises.subscribe>;

export class Win32ProcMonitor implements ProcMonitor {
  readonly event: ProcMonitorEventEmitter = new EventEmitter();

  private readonly onCreation = ([name, pid, filePath]: [
    string,
    string,
    string?,
  ]) => {
    if (!filePath) return;

    this.event.emit('creation', Number(pid), name, filePath);
  };
  private readonly onDeletion = ([name, pid]: [string, string]) => {
    this.event.emit('deletion', Number(pid), name);
  };

  private constructor(private readonly emittery: MonitorEmittery) {
    emittery.on('creation', this.onCreation);
    emittery.on('deletion', this.onDeletion);
  }

  getProcessList(): ProcessInfo[] {
    return hmc.getDetailsProcessList();
  }

  close() {
    this.emittery.off('creation', this.onCreation);
    this.emittery.off('deletion', this.onDeletion);

    return Promise.resolve();
  }

  // using multiple emittery invokes same event multiple times. so using singleton emittery
  private static EMITTERY: MonitorEmittery | null = null;
  static async initialize(): Promise<Win32ProcMonitor> {
    if (!this.EMITTERY) {
      this.EMITTERY = await wql.promises.subscribe({
        creation: true,
        deletion: true,
        filterWindowsNoise: true,
      });
    }

    return new Win32ProcMonitor(this.EMITTERY);
  }
}
