import { createServer, request as httpsRequest, type Server } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import type { IncomingMessage } from 'node:http';
import { X509Certificate } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { NODE_MAX_FRAME, NodeConnectionError } from './wire';
import { nodeServerName } from './identity';

interface NodeEndpoint { nodeId: string; address: string; certificate: string }
function tlsOptions(endpoint: NodeEndpoint) {
  const fingerprint = new X509Certificate(endpoint.certificate).fingerprint256;
  return { ca: endpoint.certificate, servername: nodeServerName(endpoint.nodeId), rejectUnauthorized: true,
    checkServerIdentity: (_host: string, certificate: import('node:tls').PeerCertificate) => {
      const error = checkServerIdentity(nodeServerName(endpoint.nodeId), certificate);
      if (error) return error;
      if (certificate.fingerprint256 !== fingerprint) return new Error('执行设备证书已经变化，需要重新配对。');
    }, minVersion: 'TLSv1.2' as const };
}
async function readBody(request: IncomingMessage, max = 32_768) {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length; if (bytes > max) throw new Error('配对请求过大。'); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function postPair(endpoint: NodeEndpoint, body: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL('/node/pair', endpoint.address), { ...tlsOptions(endpoint), method: 'POST',
      headers: { 'Content-Type': 'application/json' }, timeout: 15_000, agent: false }, response => {
      void readBody(response, 65_536).then(data => {
        if (response.statusCode !== 200) throw new Error(data.error || `配对失败：${response.statusCode}`);
        resolve(data);
      }).catch(reject);
    });
    request.once('timeout', () => request.destroy(new Error('配对连接超时，请检查设备地址。')));
    request.once('error', reject); request.end(JSON.stringify(body));
  });
}
export function openNodeSocket(endpoint: NodeEndpoint, peerId: string, localNodeId: string, token: string, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const url = new URL('/node/connect', endpoint.address); url.protocol = 'wss:';
    const socket = new WebSocket(url, { ...tlsOptions(endpoint), maxPayload: NODE_MAX_FRAME, perMessageDeflate: false,
      handshakeTimeout: 15_000, followRedirects: false,
      headers: { Authorization: `Bearer ${token}`, 'X-Graycode-Peer': peerId, 'X-Graycode-Node': localNodeId } });
    const abort = () => socket.terminate();
    const failed = (error: Error) => { signal?.removeEventListener('abort', abort); reject(error); };
    socket.once('error', failed);
    socket.once('unexpected-response', (_request, response) => {
      failed(new NodeConnectionError(response.statusCode === 410 ? 'NODE_REVOKED' : 'NODE_CONNECTION_REJECTED', response.statusCode === 410
        ? '执行设备已撤销此配对，请重新生成配对码。' : `执行设备拒绝连接（${response.statusCode}），请检查执行端的配对、账号和项目授权。`));
      response.resume(); socket.terminate();
    });
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('open', () => { signal?.removeEventListener('abort', abort); socket.removeListener('error', failed); resolve(socket); });
  });
}
export class NodeListener {
  private server?: Server;
  private sockets?: WebSocketServer;
  async start(options: { host: string; port: number; certificate: string; privateKey: string;
    pair: (input: Record<string, any>) => Promise<unknown>;
    authenticate: (request: IncomingMessage) => string;
    connected: (peerId: string, socket: WebSocket) => void;
  }): Promise<number> {
    const attempts = new Map<string, { count: number; since: number }>();
    const server = createServer({ cert: options.certificate, key: options.privateKey, minVersion: 'TLSv1.2', requestTimeout: 10_000, headersTimeout: 10_000 }, (request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/node/pair') { response.writeHead(404); response.end('{}'); return; }
        const address = request.socket.remoteAddress ?? ''; const now = Date.now();
        for (const [key, value] of attempts) if (now - value.since > 60_000) attempts.delete(key);
        const attempt = attempts.get(address) ?? { count: 0, since: now };
        if (++attempt.count > 10 || attempts.size > 1024) throw new Error('配对尝试过多，请稍后再试。'); attempts.set(address, attempt);
        const result = await options.pair(await readBody(request)); response.writeHead(200); response.end(JSON.stringify(result));
      })().catch(error => { if (!response.headersSent) response.writeHead(403); response.end(JSON.stringify({ error: (error as Error).message })); });
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: NODE_MAX_FRAME, perMessageDeflate: false });
    server.on('upgrade', (request, socket, head) => {
      try {
        if (request.url !== '/node/connect' || request.headers.origin) throw new Error('Invalid endpoint');
        const peerId = options.authenticate(request);
        sockets.handleUpgrade(request, socket, head, client => options.connected(peerId, client));
      } catch (error) { socket.end(`HTTP/1.1 ${(error as NodeConnectionError).code === 'NODE_REVOKED' ? '410 Gone' : '403 Forbidden'}\r\nConnection: close\r\n\r\n`); }
    });
    this.server = server; this.sockets = sockets;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject); server.listen(options.port, options.host, () => { server.removeListener('error', reject); resolve(); });
      });
      return (server.address() as import('node:net').AddressInfo).port;
    } catch (error) { await this.close(); throw error; }
  }
  async close() {
    const server = this.server, sockets = this.sockets; this.server = undefined; this.sockets = undefined;
    if (sockets) { for (const client of sockets.clients) client.terminate(); sockets.close(); }
    if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
