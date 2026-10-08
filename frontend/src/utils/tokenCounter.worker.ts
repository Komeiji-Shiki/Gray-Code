import { TokenCounterEngine, type TokenizerRequest, type TokenizerResponse } from './tokenCounterEngine'

const engine = new TokenCounterEngine()
const workerScope = globalThis as unknown as {
  onmessage: (event: MessageEvent<TokenizerRequest>) => void
  postMessage: (response: TokenizerResponse) => void
}
workerScope.onmessage = event => workerScope.postMessage(engine.handle(event.data))
