import Database from 'better-sqlite3';
import { PlatformStorageError } from '../errors';
import { LONG_MEMORY_SCHEMA } from './longMemory/schema';

export const SCHEMA_VERSION = 5;
const APPLICATION_ID = 0x47524350;

/** One connection owns writes and collection; callers access it through the storage worker. */
export class SqliteConnection {
  private readonly statements = new Map<string, Database.Statement>();
  constructor(private readonly native: Database.Database) {}
  prepare(sql: string): Database.Statement {
    const found = this.statements.get(sql);
    if (found) return found;
    const statement = this.native.prepare(sql);
    if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }
  transaction<T extends (...args: never[]) => unknown>(fn: T): Database.Transaction<T> { return this.native.transaction(fn); }
  pragma(source: string, options?: Database.PragmaOptions): unknown { return this.native.pragma(source, options); }
  close(): void { this.statements.clear(); this.native.close(); }
}

export function openDatabase(file: string): SqliteConnection {
  const db = new Database(file, { timeout: 1000 });
  try {
    const applicationId = db.pragma('application_id', { simple: true });
    const version = Number(db.pragma('user_version', { simple: true }));
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number };
    if ((applicationId !== 0 && applicationId !== APPLICATION_ID) || (applicationId === 0 && tables.n > 0)) {
      throw new PlatformStorageError('UNSUPPORTED_VERSION', 'This database is not a GrayCode platform database.');
    }
    if (version > SCHEMA_VERSION || (applicationId === APPLICATION_ID && version < 1)) {
      throw new PlatformStorageError('UNSUPPORTED_VERSION', `Unsupported platform storage version: ${version}`);
    }
    const sqlite = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    const [major, minor, patch] = sqlite.version.split('.').map(Number);
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
      throw new PlatformStorageError('UNSUPPORTED_VERSION', `SQLite ${sqlite.version} predates the required WAL fix (3.51.3).`);
    }
    db.pragma('foreign_keys = ON');
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('wal_autocheckpoint = 1000');
    db.pragma('journal_size_limit = 16777216');
    if (version === 0) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.exec(RUNTIME_SCHEMA);
        db.exec(SETTINGS_SCHEMA);
        db.exec(MEMORY_SCHEMA);
        db.exec(LONG_MEMORY_SCHEMA);
        db.pragma(`application_id = ${APPLICATION_ID}`);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).exclusive();
    } else {
      // Acquire ownership immediately, not halfway through the first write.
      db.transaction(() => {
        db.prepare('SELECT count(*) FROM conversations').get();
        if (version < 2) db.exec(RUNTIME_SCHEMA);
        if (version < 3) db.exec(SETTINGS_SCHEMA);
        if (version < 4) db.exec(MEMORY_SCHEMA);
        if (version < 5) db.exec(LONG_MEMORY_SCHEMA);
        if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).exclusive();
    }
    return new SqliteConnection(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

const SCHEMA = `
CREATE TABLE objects (
  hash BLOB PRIMARY KEY CHECK(length(hash)=32), raw_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL, chunk_count INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE chunks (
  hash BLOB PRIMARY KEY CHECK(length(hash)=32), raw_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL, codec INTEGER NOT NULL CHECK(codec IN (0,1)),
  data BLOB, file_id TEXT,
  CHECK((data IS NULL) != (file_id IS NULL))
) WITHOUT ROWID;
CREATE TABLE object_chunks (
  object_hash BLOB NOT NULL REFERENCES objects(hash) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, chunk_hash BLOB NOT NULL REFERENCES chunks(hash),
  PRIMARY KEY(object_hash,ordinal)
) WITHOUT ROWID;
CREATE TABLE object_edges (
  parent_hash BLOB NOT NULL REFERENCES objects(hash) ON DELETE CASCADE,
  child_hash BLOB NOT NULL REFERENCES objects(hash), PRIMARY KEY(parent_hash,child_hash)
) WITHOUT ROWID;
CREATE TABLE histories (
  id TEXT PRIMARY KEY, message_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE segments (id INTEGER PRIMARY KEY);
CREATE TABLE segment_entries (
  segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL, body_hash BLOB NOT NULL REFERENCES objects(hash),
  message_id TEXT, role TEXT NOT NULL, timestamp REAL,
  PRIMARY KEY(segment_id,ordinal)
) WITHOUT ROWID;
CREATE TABLE history_spans (
  history_id TEXT NOT NULL REFERENCES histories(id) ON DELETE CASCADE,
  start_index INTEGER NOT NULL, segment_id INTEGER NOT NULL REFERENCES segments(id),
  segment_offset INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL CHECK(count>0),
  PRIMARY KEY(history_id,start_index)
) WITHOUT ROWID;
CREATE INDEX spans_by_segment ON history_spans(segment_id);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY, title TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL,
  workspace_uri TEXT, metadata_hash BLOB NOT NULL REFERENCES objects(hash),
  history_id TEXT NOT NULL UNIQUE REFERENCES histories(id)
) WITHOUT ROWID;
CREATE INDEX conversations_by_updated ON conversations(updated_at DESC,id);
CREATE INDEX conversations_by_workspace ON conversations(workspace_uri,updated_at DESC,id);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  history_id TEXT NOT NULL UNIQUE REFERENCES histories(id), metadata_hash BLOB NOT NULL REFERENCES objects(hash)
) WITHOUT ROWID;
CREATE INDEX snapshots_by_conversation ON snapshots(conversation_id,id);
CREATE TABLE records (
  namespace TEXT NOT NULL, id TEXT NOT NULL, owner_id TEXT,
  value_hash BLOB NOT NULL REFERENCES objects(hash), PRIMARY KEY(namespace,id)
) WITHOUT ROWID;
CREATE INDEX records_by_owner ON records(namespace,owner_id,id);
CREATE TABLE migrations (
  source_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, conversation_id TEXT NOT NULL,
  metadata_hash BLOB NOT NULL REFERENCES objects(hash), history_id TEXT REFERENCES histories(id),
  imported_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('importing','complete'))
) WITHOUT ROWID;
`;

const RUNTIME_SCHEMA = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL, agent_id TEXT NOT NULL, workspace_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','awaiting_approval','awaiting_input','completed','failed','cancelled','interrupted')),
  created_at REAL NOT NULL, updated_at REAL NOT NULL,
  value_hash BLOB NOT NULL REFERENCES objects(hash)
) WITHOUT ROWID;
CREATE INDEX runs_by_conversation ON runs(conversation_id,created_at DESC,id);
CREATE INDEX runs_by_actor ON runs(actor_id,created_at DESC,id);
CREATE INDEX runs_by_status ON runs(status,created_at DESC,id);
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, timestamp REAL NOT NULL, type TEXT NOT NULL,
  payload_hash BLOB NOT NULL REFERENCES objects(hash), PRIMARY KEY(run_id,sequence)
) WITHOUT ROWID;
`;

const SETTINGS_SCHEMA = 'ALTER TABLE records ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;';


const MEMORY_SCHEMA = `
CREATE TABLE memory_scopes (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, workspace_key TEXT,
  entry_count INTEGER NOT NULL DEFAULT 0 CHECK(entry_count>=0), revision INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX memory_scopes_by_actor ON memory_scopes(actor_id,workspace_key);
CREATE TABLE memory_entries (
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position>=0), body_hash BLOB NOT NULL REFERENCES objects(hash),
  PRIMARY KEY(scope_id,position)
) WITHOUT ROWID;
CREATE TABLE memory_summaries (
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
  lo INTEGER NOT NULL, hi INTEGER NOT NULL CHECK(hi>lo), body_hash BLOB NOT NULL REFERENCES objects(hash),
  PRIMARY KEY(scope_id,lo,hi)
) WITHOUT ROWID;
CREATE TABLE memory_revisions (
  scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, kind TEXT NOT NULL, created_at REAL NOT NULL, before_length INTEGER NOT NULL,
  source_hash BLOB NOT NULL REFERENCES objects(hash), PRIMARY KEY(scope_id,revision)
) WITHOUT ROWID;
CREATE TABLE memory_revision_entries (
  scope_id TEXT NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL,
  body_hash BLOB REFERENCES objects(hash), PRIMARY KEY(scope_id,revision,position),
  FOREIGN KEY(scope_id,revision) REFERENCES memory_revisions(scope_id,revision) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE memory_revision_summaries (
  scope_id TEXT NOT NULL, revision INTEGER NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL,
  body_hash BLOB REFERENCES objects(hash), PRIMARY KEY(scope_id,revision,lo,hi),
  FOREIGN KEY(scope_id,revision) REFERENCES memory_revisions(scope_id,revision) ON DELETE CASCADE
) WITHOUT ROWID;
`;
