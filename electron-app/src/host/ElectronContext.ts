/**
 * ElectronContext.ts
 *
 * A minimal `vscode.ExtensionContext`-shaped object for the GrayCode backend.
 * - globalStorageUri  -> <userData>/graycode
 * - globalState       -> JSON-file-backed Memento
 * - extensionPath     -> the Gray-Code repo root (for resources)
 * - subscriptions     -> array
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { Uri } from '../vscode-shim';

const WIN32 = process.platform === 'win32';

class FileMemento {
  private cache: Record<string, any> = {};
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private filePath: string) {
    try {
      this.cache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      this.cache = {};
    }
  }

  get<T = any>(key: string, defaultValue?: T): T {
    return key in this.cache ? (this.cache[key] as T) : (defaultValue as T);
  }

  async update(key: string, value: any): Promise<void> {
    if (value === undefined) {
      delete this.cache[key];
    } else {
      this.cache[key] = value;
    }
    const content = JSON.stringify(this.cache, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      await fsp.writeFile(tmp, content, 'utf-8');
      await fsp.rename(tmp, this.filePath);
    }).catch((err) => console.error('[ElectronContext] globalState persist failed:', err));
    await this.writeQueue;
  }

  /** 等待串行写队列排空（退出前调用，避免打开/保存工作区后立即退出丢收藏） */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  keys(): readonly string[] {
    return Object.keys(this.cache);
  }
}

export interface ElectronContextOptions {
  /** Where the app stores its data (e.g. app.getPath('userData')). */
  userDataPath: string;
  /** The Gray-Code repo root (used as extensionPath). */
  extensionPath: string;
}

export class ElectronContext {
  readonly globalStorageUri: Uri;
  readonly globalStoragePath: string;
  readonly storageUri: Uri;
  readonly extensionUri: Uri;
  readonly extensionPath: string;
  readonly extensionMode = 3; // ExtensionMode.Production
  readonly globalState: FileMemento;
  readonly workspaceState: FileMemento;
  readonly subscriptions: Array<{ dispose(): void }> = [];
  readonly extension: any;

  /** 等待全部 Memento 写队列排空（退出前调用，防止收藏/状态丢失） */
  async flush(): Promise<void> {
    await Promise.all([this.globalState.flush(), this.workspaceState.flush()]);
  }

  constructor(options: ElectronContextOptions) {
    this.globalStoragePath = path.join(options.userDataPath, 'graycode');
    this.globalStorageUri = Uri.file(this.globalStoragePath);
    this.storageUri = Uri.file(options.userDataPath);
    this.extensionPath = options.extensionPath;
    this.extensionUri = Uri.file(options.extensionPath);
    this.globalState = new FileMemento(path.join(this.globalStoragePath, 'global-state.json'));
    this.workspaceState = new FileMemento(path.join(options.userDataPath, 'workspace-state.json'));
    this.extension = {
      id: 'czocelot.graycode',
      extensionPath: this.extensionPath,
      extensionUri: this.extensionUri,
      packageJSON: {
        name: 'graycode',
        displayName: 'Gray Code',
        version: readRootPackageVersion(this.extensionPath),
        publisher: 'czocelot'
      }
    };
    // normalize Windows-style extensionPath for globalStorageUri consistency
    if (WIN32) {
      // fsPath comes from Uri.file which already yields backslashes
    }
  }
}

function readRootPackageVersion(extensionPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
