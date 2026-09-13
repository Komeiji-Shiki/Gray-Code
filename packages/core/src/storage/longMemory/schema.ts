/** 与现有日志记忆并存，所有变更仍由同一 SQLite worker 提交。 */
export const LONG_MEMORY_SCHEMA = `
CREATE TABLE long_memory_scopes (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, kind TEXT NOT NULL, scope_key TEXT, realm TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0, invalidation INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX long_memory_scopes_actor ON long_memory_scopes(actor_id,kind,realm);
CREATE TABLE long_memory_sources (
  scope_id TEXT NOT NULL REFERENCES long_memory_scopes(id), id TEXT NOT NULL, version INTEGER NOT NULL,
  recorded_at REAL NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(scope_id,id,version)
) WITHOUT ROWID;
CREATE TABLE long_memory_records (
  row_id INTEGER PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES long_memory_scopes(id),
  id TEXT NOT NULL, version INTEGER NOT NULL, recorded_at REAL NOT NULL,
  valid_from REAL NOT NULL, valid_to REAL, kind TEXT NOT NULL, confidence TEXT NOT NULL,
  subject TEXT NOT NULL, attribute TEXT, value TEXT, topic TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
  UNIQUE(scope_id,id,version)
);
CREATE INDEX long_memory_records_lookup ON long_memory_records(scope_id,id,recorded_at DESC,version DESC);
CREATE INDEX long_memory_records_topic ON long_memory_records(scope_id,topic,kind);
CREATE INDEX long_memory_records_attribute ON long_memory_records(scope_id,subject,attribute);
CREATE TABLE long_memory_dependencies (
  record_row INTEGER NOT NULL REFERENCES long_memory_records(row_id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL, parent_kind TEXT NOT NULL, parent_id TEXT NOT NULL, parent_version INTEGER NOT NULL,
  PRIMARY KEY(record_row,parent_kind,parent_id,parent_version)
) WITHOUT ROWID;
CREATE INDEX long_memory_dependencies_parent ON long_memory_dependencies(scope_id,parent_kind,parent_id,parent_version);
CREATE TABLE long_memory_supersedes (
  record_row INTEGER NOT NULL REFERENCES long_memory_records(row_id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL, original_id TEXT NOT NULL, PRIMARY KEY(record_row,original_id)
) WITHOUT ROWID;
CREATE INDEX long_memory_supersedes_original ON long_memory_supersedes(scope_id,original_id);
CREATE TABLE long_memory_vectors (
  record_row INTEGER PRIMARY KEY REFERENCES long_memory_records(row_id) ON DELETE CASCADE,
  model TEXT NOT NULL, dimensions INTEGER NOT NULL, value BLOB NOT NULL
);
CREATE VIRTUAL TABLE long_memory_terms USING fts5(tokens, tokenize='unicode61');
CREATE TABLE long_memory_tombstones (
  scope_id TEXT NOT NULL REFERENCES long_memory_scopes(id), kind TEXT NOT NULL, id TEXT NOT NULL,
  action TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(scope_id,kind,id)
) WITHOUT ROWID;
CREATE TABLE long_memory_jobs (
  scope_id TEXT NOT NULL REFERENCES long_memory_scopes(id), id TEXT NOT NULL,
  status TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(scope_id,id)
) WITHOUT ROWID;
CREATE INDEX long_memory_jobs_status ON long_memory_jobs(status,scope_id,id);
CREATE TABLE long_memory_job_dependencies (
  scope_id TEXT NOT NULL, job_id TEXT NOT NULL, parent_kind TEXT NOT NULL, parent_id TEXT NOT NULL, parent_version INTEGER NOT NULL,
  PRIMARY KEY(scope_id,job_id,parent_kind,parent_id,parent_version),
  FOREIGN KEY(scope_id,job_id) REFERENCES long_memory_jobs(scope_id,id) ON DELETE CASCADE
) WITHOUT ROWID;
`;
