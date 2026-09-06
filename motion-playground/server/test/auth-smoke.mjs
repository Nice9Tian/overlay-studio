import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { probeAuth } from '../runners/auth.mjs';

async function main() {
  try {
    console.log('--- Part 1: Auth Probe ---');
    for (const provider of ['claude', 'agy', 'codex']) {
      const res = await probeAuth(provider);
      console.log(`[${provider}]`);
      console.log(JSON.stringify(res, null, 2));
      assert(typeof res === 'object' && res !== null, `${provider} result should be an object`);
      assert(Array.isArray(res.loginCommand), `${provider} loginCommand should be an array`);
    }

    const t0 = Date.now();
    await probeAuth('claude');
    const t1 = Date.now();
    console.log(`[claude] Cached probe took ${t1 - t0}ms`);
    console.log('PASS: Auth Probe');

    console.log('\n--- Part 2: AI Config ---');
    const tmpFile = path.join(os.tmpdir(), 'overlay-studio', `ai-config-smoke-${Math.floor(Math.random() * 100000)}.json`);
    process.env.OVERLAY_AI_CONFIG = tmpFile;

    const { readConfig, writeConfig, publicConfig } = await import('../ai-config.mjs');

    const def = readConfig();
    assert.deepStrictEqual(def, {
      version: 1,
      defaultProvider: null,
      api: { vendor: 'anthropic', baseUrl: '', apiKey: '', model: '', maxTokens: 4096 }
    });

    writeConfig({ api: { apiKey: 'sk-test-abcd1234', model: 'x-1' } });
    const p1 = publicConfig();
    assert.deepStrictEqual(p1.api.apiKey, { set: true, last4: '1234' });
    assert.strictEqual(p1.api.model, 'x-1');

    const p1Str = JSON.stringify(p1);
    assert(!p1Str.includes('sk-test-abcd1234'));
    assert(!p1Str.includes('sk-test'));

    writeConfig({ api: { apiKey: '' } });
    assert.strictEqual(readConfig().api.apiKey, 'sk-test-abcd1234');

    writeConfig({ api: { apiKey: null } });
    assert.strictEqual(readConfig().api.apiKey, '');
    assert.deepStrictEqual(publicConfig().api.apiKey, { set: false, last4: '' });

    assert.throws(() => writeConfig({ api: { vendor: 'nope' } }), /vendor 只能是/);

    writeConfig({ someUnknown: true });

    writeConfig({ defaultProvider: 'api' });
    assert.strictEqual(readConfig().defaultProvider, 'api');

    assert.throws(() => writeConfig({ api: { baseUrl: 'ftp://x' } }), /baseUrl 必须是/);

    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
    console.log('PASS: AI Config');
    
    console.log('\nALL PASS');
  } catch (e) {
    console.error(`FAIL: ${e.message}`, e);
    process.exit(1);
  }
}

main();
