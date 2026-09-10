import { parentPort } from 'node:worker_threads';
import { evaluateWorldbooks, transformCharacterText } from './engine';
parentPort!.on('message', input => {
  try {
    const value = input.type === 'regex' ? transformCharacterText(input.text, input.rules, input.context)
      : input.type === 'regex-batch' ? input.items.map((item: any) => transformCharacterText(item.text, input.rules, item.context))
      : evaluateWorldbooks(input.options);
    parentPort!.postMessage({ value });
  } catch (error) { parentPort!.postMessage({ error: (error as Error).message }); }
});
