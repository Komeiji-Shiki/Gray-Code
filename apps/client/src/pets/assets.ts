import type { PetImport, PetResource, PetRuntime } from '@graycode/contracts';
import { rpc } from '../api';
import type { PetRenderPayload } from './protocol';

// 缓存归父页面所有，播放器重挂只转移副本，原始缓冲不会被 iframe detach。
const bundles = new Map<string, Promise<PetRenderPayload['bundle']>>();
const runtimes = new Map<string, Promise<ArrayBuffer | undefined>>();

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
  const pending = load().catch(error => {
    if (cache.get(key) === pending) cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  while (cache.size > 2) cache.delete(cache.keys().next().value!);
  return pending;
}

function decode(data: string): ArrayBuffer {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0)).buffer;
}

async function loadBundle(resource: PetResource): Promise<PetRenderPayload['bundle']> {
  const bundle: PetImport = await rpc('pets.bundle', { id: resource.id });
  return {
    entry: bundle.entry,
    files: bundle.files.map(file => ({ path: file.path, bytes: decode(file.data) })),
  };
}

export async function petRenderPayload(resource: PetResource, runtime?: PetRuntime): Promise<PetRenderPayload> {
  const bundle = cached(bundles, resource.sha256, () => loadBundle(resource));
  let core: Promise<ArrayBuffer | undefined> | undefined;
  if (resource.kind === 'live2d') {
    const key = runtime?.sha256 ?? 'current';
    core = cached(runtimes, key, () => rpc('pets.runtime.get').then(value => value ? decode(value.data) : undefined));
  }
  const [files, runtimeBytes] = await Promise.all([bundle, core]);
  return {
    resource,
    bundle: { entry: files.entry, files: files.files.map(file => ({ path: file.path, bytes: file.bytes.slice(0) })) },
    ...(runtimeBytes ? { runtime: runtimeBytes.slice(0) } : {}),
  };
}

export function clearPetRuntimeCache(): void { runtimes.clear(); }
