import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PlatformApplication } from "../application";
import { RemoteAccessService } from '../transport/remoteAccess';
import path from 'node:path';
import { environmentSecretCodec } from '../settings/environmentSecrets';

export async function runApplicationCommand(
  command: string,
  dataDirectory: string,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const application = await PlatformApplication.open({ dataDirectory,
    ...(command === 'serve' ? { remoteAccess: (app: PlatformApplication) => new RemoteAccessService(app, { clientDirectory: values.web ? path.resolve(__dirname, '../../client/dist') : undefined }) } : {}),
    secretCodec: environmentSecretCodec(typeof values['key-env'] === 'string' ? values['key-env'] : undefined) });
  try {
    if (command === "serve") {
      const variable =
        typeof values["token-env"] === "string" ? values["token-env"] : "";
      const token = variable ? process.env[variable] : undefined;
      if (!token)
        throw new Error(
          "serve requires --token-env <environment-variable> containing a random access token.",
        );
      await application.remoteAccess!.initialize({
        token,
        port: values.port ? Number(values.port) : 0,
        publicOrigin: typeof values['public-origin'] === 'string' ? values['public-origin'] : undefined,
      });
      const status = application.remoteAccess!.status();
      await application.nodes.activate();
      process.stdout.write(
        `GrayCode is listening on ${status.localAddress}. Authentication is required.${values.web ? ` Web: ${status.address}/` : ''}\n`,
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      await application.remoteAccess!.close();
      return;
    }
    if (typeof values.text !== "string" || !values.text.trim())
      throw new Error("chat requires --text <message>.");
    const conversation =
      typeof values.conversation === "string"
        ? await application.conversation("owner", values.conversation)
        : await application.createConversation(
            "owner",
            values.text.slice(0, 80),
            typeof values.workspace === "string" ? values.workspace : undefined,
          );
    const input = createInterface({ input: process.stdin, terminal: false });
    let runId: string | undefined;
    const unsubscribe = application.runtime.subscribe((notification) => {
      if (notification.type === "model.delta")
        process.stdout.write(
          notification.parts
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join(""),
        );
      else if (notification.type === "event") {
        const event = notification.event;
        if (event.type === "approval.requested")
          process.stderr.write(
            `\nApproval ${event.payload.id}: ${JSON.stringify(event.payload)}\nEnter: ${event.payload.choices ? 'choose <id> <option number, starting at 1>' : 'approve <id> or deny <id>'}\n`,
          );
        if (event.type === "question.asked")
          process.stderr.write(
            `\nQuestion ${event.payload.id}: ${JSON.stringify(event.payload.questions)}\nEnter: answer <id> ["answer one", "answer two"]\n`,
          );
      }
    });
    const interrupt = () => {
      if (runId) void application.runtime.cancel(runId, "owner");
    };
    process.once("SIGINT", interrupt);
    input.on("line", (line) => {
      const [action, id, ...rest] = line.split(" ");
      void (async () => {
        if (action === "approve" || action === "deny")
          await application.runtime.resolveApproval(
            id,
            "owner",
            action === "approve",
          );
        else if (action === 'choose') {
          const choice = application.runtime.pendingApprovals().find(item => item.id === id)?.choices?.[Number(rest[0]) - 1];
          if (!choice) throw new Error('请选择列出的选项序号。');
          await application.runtime.resolveApproval(id, 'owner', false, choice.id);
        } else if (action === "answer")
          await application.runtime.answerQuestion(
            id,
            "owner",
            JSON.parse(rest.join(" ")),
          );
        else if (action === "cancel") interrupt();
      })().catch((error) => process.stderr.write(`${error.message}\n`));
    });
    try {
      const run = await application.runtime.start({
        requestKey: randomUUID(),
        actorId: "owner",
        agentId: String(values.agent ?? "default"),
        conversationId: conversation.id,
        workspaceId: conversation.workspaceId as string | undefined,
        ...(values.provider ? { providerId: String(values.provider) } : {}),
        ...(values.model ? { modelOverride: String(values.model) } : {}),
        ...(values.effort ? { reasoningEffort: String(values.effort) } : {}),
        message: { role: "user", parts: [{ text: values.text }] },
      });
      runId = run.id;
      const result = await application.runtime.wait(run.id);
      process.stdout.write(
        `\n${JSON.stringify({ run: result, conversationId: conversation.id })}\n`,
      );
      if (result?.status !== "completed") process.exitCode = 2;
    } finally {
      unsubscribe();
      input.close();
      process.removeListener("SIGINT", interrupt);
    }
  } finally {
    await application.close();
  }
}
