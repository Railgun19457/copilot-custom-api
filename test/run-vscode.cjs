const assert = require('node:assert/strict');
const { mkdir, mkdtemp, realpath, rm } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');
const { fixtureServer, protocolPaths } = require('./fixture.cjs');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const testRoot = path.join(workspace, '.vscode-test');
  await mkdir(testRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(testRoot, 'run-'));
  const fixture = await fixtureServer();
  let success = false;
  try {
    const options = {
      extensionDevelopmentPath: workspace,
      extensionTestsPath: path.join(__dirname, 'vscode.cjs'),
      ...(process.env.VSCODE_EXECUTABLE
        ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE }
        : { version: '1.145.3' }),
    };
    const port = await availablePort();
    const launchArgs = [
      '--user-data-dir', path.join(runDir, 'user'),
      '--extensions-dir', path.join(runDir, 'extensions'),
      '--shared-data-dir', path.join(runDir, 'shared'),
      '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
      '--disable-updates', '--disable-telemetry',
      `--remote-debugging-port=${port}`,
    ];
    for (const profile of ['default', 'secondary']) {
      await runTests({
        ...options,
        launchArgs: profile === 'default' ? launchArgs : [...launchArgs, '--profile', 'Custom API Test'],
        extensionTestsEnv: {
          CUSTOM_API_TEST_URL: fixture.baseUrl,
          CUSTOM_API_TEST_PROFILE: profile,
          CUSTOM_API_TEST_CDP_PORT: String(port),
        },
      });
    }
    for (const route of Object.values(protocolPaths)) {
      assert.ok(fixture.hits.includes(route), `Missing HTTP traffic for ${route}`);
    }
    assert.equal(fixture.hits.filter(route => route === '/auth/v1/chat/completions').length, 1);
    assert.deepEqual(fixture.routed.map(hit => [hit.prompt.slice('Routing check '.length), hit.path, hit.model]), [
      ['primary', '/auth/v1/responses', 'sample'],
      ['fail once', '/auth/v1/responses', 'sample'],
      ['primary recovers', '/auth/v1/responses', 'sample'],
      ['fail after recovery', '/auth/v1/responses', 'sample'],
      ['fail twice', '/auth/v1/responses', 'sample'],
      ['fail twice', '/v1/chat/completions', 'sample'],
      ['fallback in another session', '/v1/chat/completions', 'sample'],
    ]);
    assert.ok(fixture.hits.includes('/auth/v1/models'), 'The manager should fetch the model list with the saved key');
    success = true;
  } finally {
    await fixture.close();
    if (success && !process.env.CUSTOM_API_KEEP_VSCODE_TEST) {
      const resolved = await realpath(runDir);
      if (path.dirname(resolved) === await realpath(testRoot) && path.basename(resolved).startsWith('run-')) {
        await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
      }
    } else {
      console.log('Isolated VS Code test data:', runDir);
      console.log('Test HTTP routes:', fixture.hits);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
