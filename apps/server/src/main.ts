import path from "node:path";
import { parseArgs } from "node:util";
import {
  PlatformStorage,
  PlatformStorageError,
  importLegacyHistory,
  validateLegacyImportPaths,
} from "@graycode/core";
import { runApplicationCommand } from "./cli/runtime";
import { importLifeBook } from './memory/imports/migrate';

const HELP = `GrayCode independent platform core

Usage: npm run platform -- --data <new-data-directory> <command> [arguments]

Commands:
  chat --text <message>              Run an independent model/tool task (--agent, --workspace, --conversation, --provider, --model, --effort)
  serve --token-env <variable>       Start the authenticated loopback RPC/event service (--port)
        --web                       Serve the shared chat, settings and workspace UI
        --public-origin <https-url>  Explicit HTTPS reverse-proxy origin (listener stays on loopback)
        --key-env <variable>         Encrypt saved credentials with a 64-character hexadecimal deployment key
  info                              Database version and storage statistics
  create <id> [title]                Create an empty conversation
  list                              List conversations (--limit, --workspace)
  history <id>                      Read a page (--limit, --offset, --before)
  append <id> --text <message>       Append a user message (--revision)
  fork <source-id> <target-id>       Share history into a new conversation (--before)
  import-legacy <old-data-directory> Import JSON/NDJSON history without changing the source
  import-lifebook <directory>        Import a separate review library, preserving every source file
        --graph-export <json>       Full Kuzu export from scripts/export-lifebook-graph.py
        --source-manifest <json>    Verify a snapshot and retain original file timestamps
        --actor <id> --name <name>  Target account (default owner) and library display name
  verify                            Verify SQLite and referenced content checksums
  gc                                Reclaim unreferenced content (not user history)

Build first: npm run build:platform
Keep the old application closed while importing. Source and destination must be separate.
Only chat makes model requests; only serve starts a loopback listener. No automatic storage cutover occurs.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      help: { type: "boolean", short: "h" },
      text: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
      before: { type: "string" },
      revision: { type: "string" },
      workspace: { type: "string" },
      agent: { type: "string" },
      conversation: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      port: { type: "string" },
      "token-env": { type: "string" },
      "key-env": { type: "string" },
      "public-origin": { type: "string" },
      "graph-export": { type: "string" },
      "source-manifest": { type: "string" },
      actor: { type: "string" },
      name: { type: "string" },
      web: { type: "boolean" },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(HELP);
    return;
  }
  if (!values.data)
    throw new Error("--data must explicitly select the new data directory.");
  const [command, id, extra] = positionals;
  if (command === "chat" || command === "serve") {
    await runApplicationCommand(command, path.resolve(values.data), values);
    return;
  }
  if (command === "import-legacy" || command === 'import-lifebook') {
    if (!id) throw new Error(`${command} requires the source directory.`);
    await validateLegacyImportPaths(
      path.resolve(id),
      path.resolve(values.data),
    );
  }
  const number = (value?: string) =>
    value === undefined ? undefined : Number(value);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Interrupted by user."));
  process.once("SIGINT", interrupt);
  const store = await PlatformStorage.open(path.resolve(values.data));
  try {
    let result: unknown;
    switch (command) {
      case 'import-lifebook': {
        let previousPhase = '', previousTime = 0;
        result = await importLifeBook(store, path.resolve(id!), { actorId: values.actor ?? 'owner', name: values.name,
          graphExport: values['graph-export'], sourceManifest: values['source-manifest'], signal: abort.signal,
          onProgress(progress) {
            if (progress.phase !== previousPhase || Date.now() - previousTime > 2000 || progress.completed === progress.total) {
              process.stderr.write(`${progress.phase}: ${progress.completed}/${progress.total}\n`);
              previousPhase = progress.phase; previousTime = Date.now();
            }
          } });
        break;
      }
      case "info":
        result = await store.statistics();
        break;
      case "create": {
        if (!id) throw new Error("create requires an id.");
        const now = Date.now();
        result = await store.createConversation({
          id,
          title: extra ?? id,
          createdAt: now,
          updatedAt: now,
          ...(values.workspace ? { workspaceUri: values.workspace } : {}),
        });
        break;
      }
      case "list":
        result = await store.listConversations({
          limit: number(values.limit),
          workspaceUri: values.workspace,
        });
        break;
      case "history":
        if (!id) throw new Error("history requires a conversation id.");
        result = await store.readHistory(id, {
          limit: number(values.limit),
          offset: number(values.offset),
          beforeIndex: number(values.before),
        });
        break;
      case "append":
        if (!id || values.text === undefined)
          throw new Error("append requires an id and --text.");
        result = await store.appendHistory(
          id,
          [
            {
              role: "user",
              parts: [{ text: values.text }],
              timestamp: Date.now(),
            },
          ],
          { expectedRevision: number(values.revision) },
        );
        break;
      case "fork": {
        if (!id || !extra)
          throw new Error("fork requires source and target ids.");
        const original = await store.getConversation(id);
        if (!original) throw new Error("Source conversation not found.");
        const now = Date.now();
        result = await store.forkConversation(
          id,
          { ...original, id: extra, createdAt: now, updatedAt: now },
          {
            beforeIndex: number(values.before),
            expectedRevision: number(values.revision),
          },
        );
        break;
      }
      case "import-legacy": {
        if (!id)
          throw new Error("import-legacy requires the old data directory.");
        const report = await importLegacyHistory(store, path.resolve(id), {
          signal: abort.signal,
          onProgress: (progress) =>
            process.stderr.write(
              `Imported ${progress.conversationId}: ${progress.importedMessages} messages\n`,
            ),
        });
        result = report;
        if (report.issues.length || report.pendingArtifacts.length)
          process.exitCode = 2;
        break;
      }
      case "verify": {
        const report = await store.verify();
        result = report;
        if (!report.ok) process.exitCode = 2;
        break;
      }
      case "gc":
        result = await store.collectGarbage();
        break;
      default:
        throw new Error(`Unknown command: ${command}\n${HELP}`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    await store.close();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof PlatformStorageError ? { code: error.code } : {}),
    })}\n`,
  );
  process.exitCode = 1;
});
