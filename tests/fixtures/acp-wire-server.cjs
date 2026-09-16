(async () => {
  const { AgentSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');
  const { Readable, Writable } = require('stream');
  const AcpServer = require('../../src/acp-server');
  let server;
  const conn = new AgentSideConnection(client => (server = new AcpServer(client, {
    workerFile: require('path').join(__dirname, 'acp-worker.cjs'),
  })), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
  await conn.closed;
  await server.close();
})().catch(err => { console.error(err); process.exitCode = 1; });
