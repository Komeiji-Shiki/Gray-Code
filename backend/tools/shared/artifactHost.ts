import { AsyncLocalStorage } from 'node:async_hooks';
export { normalizeLineEndingsToLF } from './textUtils';

export interface ArtifactDocumentPath { fsPath: string }
export interface ArtifactDocumentHost {
  resolve(path: string): { uri?: ArtifactDocumentPath; error?: string };
  workspaces(): Array<{ name: string }>;
  read(path: ArtifactDocumentPath): Promise<Uint8Array>;
  write(path: ArtifactDocumentPath, bytes: Uint8Array): Promise<void>;
  stat(path: ArtifactDocumentPath): Promise<{ size: number }>;
  prepareParent(path: string): Promise<void>;
}
const artifactHosts = new AsyncLocalStorage<ArtifactDocumentHost>();
export function withArtifactHost<T>(host: ArtifactDocumentHost, action: () => T): T { return artifactHosts.run(host, action); }
function host() { const value = artifactHosts.getStore(); if (!value) throw new Error('文档操作缺少工作区宿主。'); return value; }
export const resolveUriWithInfo = (path: string) => host().resolve(path);
export const getAllWorkspaces = () => host().workspaces();
export const documentReadFile = (path: ArtifactDocumentPath) => host().read(path);
export const documentWriteFile = (path: ArtifactDocumentPath, bytes: Uint8Array) => host().write(path, bytes);
export const documentStat = (path: ArtifactDocumentPath) => host().stat(path);
export const ensureParentDir = (path: string) => host().prepareParent(path);
export const ensureParentDirWithFs = ensureParentDir;
export function isScopedPathAllowedWithMultiRoot(value: string, validator: (path: string) => boolean): boolean {
  if (validator(value)) return true;
  if (getAllWorkspaces().length <= 1) return false;
  const normalized = value.replaceAll('\\', '/'); const separator = normalized.indexOf('/');
  if (separator <= 0) return false;
  const prefix = normalized.slice(0, separator);
  return prefix !== '.' && prefix !== '..' && !prefix.includes(':') && validator(normalized.slice(separator + 1));
}
export const DESIGN_PATH_SCOPE_LABEL = '.graycode/design/**.md';
export const PLAN_PATH_SCOPE_LABEL = '.graycode/plans/**.md';
export const REVIEW_PATH_SCOPE_LABEL = '.graycode/review/**.md';
export const PROGRESS_PATH_SCOPE_LABEL = '.graycode/progress.md';
export const buildPathRejectedError = (kind: string, scope: string, path: string) => `Invalid ${kind} path. Only "${scope}" is allowed. Rejected path: ${path}`;
export const buildPathReceivedError = (kind: string, scope: string, path: string) => `Invalid ${kind} path. Only "${scope}" is allowed. Received: ${path}`;
