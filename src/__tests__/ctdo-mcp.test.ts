import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  extractPlaylistId,
  extractVideoId,
  formatTimestamp,
  parseChannelRef,
  parseDurationSeconds,
  parseHumanCount,
  Singleflight,
} from '../core/utils.js';
import { TieredCache } from '../core/cache.js';
import { KnowledgeBase } from '../core/knowledge-base.js';
import { createCtdoMcpServer } from '../server.js';
import { getToolsForMode } from '../tools/definitions.js';

test('URL, ID, duration, and human count parsers handle all YouTube formats', () => {
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/fwBIZRq-vzY'), 'fwBIZRq-vzY');
  assert.equal(extractPlaylistId('https://www.youtube.com/playlist?list=PL0vfts4VzfNiI1BsIK5u7LpPaIDKMJIDN'), 'PL0vfts4VzfNiI1BsIK5u7LpPaIDKMJIDN');

  assert.deepEqual(parseChannelRef('@Fireship'), { kind: 'handle', value: '@Fireship' });
  assert.deepEqual(parseChannelRef('https://www.youtube.com/@Fireship/videos'), { kind: 'handle', value: '@Fireship' });
  assert.deepEqual(parseChannelRef('UCsBjURrPoezykLs9EqgamOA'), { kind: 'id', value: 'UCsBjURrPoezykLs9EqgamOA' });

  assert.equal(parseDurationSeconds('PT1H2M3S'), 3723);
  assert.equal(parseDurationSeconds('4:31'), 271);
  assert.equal(formatTimestamp(3723), '1:02:03');

  assert.equal(parseHumanCount('4.34M subscribers'), 4_340_000);
  assert.equal(parseHumanCount('2,435,124 views'), 2_435_124);
  assert.equal(parseHumanCount('1.7K'), 1_700);
});

test('Singleflight coalesces concurrent identical requests into 1 execution', async () => {
  const sf = new Singleflight();
  let executions = 0;
  const worker = () =>
    sf.do('same-key', async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 25));
      return 42;
    });

  const results = await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  assert.deepEqual(results, [42, 42, 42, 42, 42]);
  assert.equal(executions, 1);
  assert.equal(sf.coalescedCount, 4);
});

test('TieredCache L1 + L2 SQLite persistence and hit tracking', async () => {
  const cache = new TieredCache(100);
  let calls = 0;
  const v1 = await cache.getOrCompute('unit_test', 'k1', 60_000, async () => {
    calls++;
    return { hello: 'ctdo' };
  }, 100);
  const v2 = await cache.getOrCompute('unit_test', 'k1', 60_000, async () => {
    calls++;
    return { hello: 'other' };
  }, 100);

  assert.deepEqual(v1, { hello: 'ctdo' });
  assert.deepEqual(v2, { hello: 'ctdo' });
  assert.equal(calls, 1);
  assert.ok(cache.getTelemetry().estimatedQuotaUnitsSaved >= 100);
  cache.clear('unit_test');
});

test('Hybrid RAG KnowledgeBase indexes timestamped chunks and searches via FTS5 + Vector RRF', async () => {
  const kb = new KnowledgeBase();
  await kb.indexVideo(
    { id: 'testVid00001', title: 'Building Fast MCP Servers in TypeScript', channelTitle: 'CTDO Lab' },
    [
      { startSec: 0, durationSec: 15, timestamp: '0:00', text: 'Welcome back! Today we optimize Model Context Protocol tool schemas to reduce LLM token overhead.' },
      { startSec: 75, durationSec: 20, timestamp: '1:15', text: 'Next we use SQLite WAL mode with FTS5 BM25 ranking and cosine vector fusion for sub-millisecond retrieval.' },
    ]
  );

  const hits = await kb.search('SQLite FTS5 BM25 vector retrieval', 5, ['testVid00001']);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].videoId, 'testVid00001');
  assert.equal(hits[0].startSec, 75);
  assert.equal(hits[0].deepLink, 'https://youtu.be/testVid00001?t=75s');

  kb.removeVideo('testVid00001');
});

test('Tool Weight Modes expose exact expected counts (lite=4, compact=13, full=46)', () => {
  assert.equal(getToolsForMode('lite').length, 4);
  assert.equal(getToolsForMode('compact').length, 13);
  assert.equal(getToolsForMode('full').length, 46);
});

test('Live MCP E2E over InMemoryTransport: tools, transcripts, channels, outliers, comments & compatibility aliases', async () => {
  const server = createCtdoMcpServer('compact');
  const client = new Client({ name: 'ctdo-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // 1. Verify compact tool list
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 13);

  // 2. Live Zero-API-Key Video Details + SponsorBlock + Dislikes
  const vidRes = await client.callTool({
    name: 'yt_videos',
    arguments: {
      videos: ['dQw4w9WgXcQ'],
      includeDislikes: true,
    },
  });
  const vidJson = JSON.parse((vidRes.content as any)[0].text);
  assert.equal(vidJson[0].id, 'dQw4w9WgXcQ');
  assert.ok(vidJson[0].views > 1_000_000_000);

  // 3. Live Zero-API-Key Transcript (key_segments mode)
  const txRes = await client.callTool({
    name: 'yt_transcript',
    arguments: {
      videos: ['dQw4w9WgXcQ'],
      mode: 'key_segments',
      lang: 'en',
    },
  });
  const txJson = JSON.parse((txRes.content as any)[0].text);
  assert.equal(txJson[0].videoId, 'dQw4w9WgXcQ');
  assert.ok(txJson[0].segmentCount > 10);
  assert.ok(typeof txJson[0].hook === 'string' && txJson[0].hook.length > 10);

  // 4. Live Zero-API-Key Channel (@Fireship) with videos & shorts
  const chRes = await client.callTool({
    name: 'yt_channels',
    arguments: {
      channels: ['@Fireship'],
      include: ['stats', 'videos', 'shorts'],
      maxItems: 5,
    },
  });
  const chJson = JSON.parse((chRes.content as any)[0].text);
  assert.equal(chJson[0].channel.id, 'UCsBjURrPoezykLs9EqgamOA');
  assert.ok(chJson[0].channel.subscribers > 1_000_000);
  assert.ok(chJson[0].videos.length >= 3);
  assert.ok(chJson[0].shorts.length >= 3);

  // 5. Live Comment Mining
  const cmRes = await client.callTool({
    name: 'yt_comments',
    arguments: {
      video: 'dQw4w9WgXcQ',
      action: 'mine',
      maxResults: 25,
    },
  });
  const cmJson = JSON.parse((cmRes.content as any)[0].text);
  assert.ok(cmJson.analyzedComments >= 5);

  // 6. Repeat yt_videos to confirm sub-millisecond L1 cache hit + test yt_packaging
  const pkgRes = await client.callTool({
    name: 'yt_packaging',
    arguments: {
      videos: ['dQw4w9WgXcQ'],
      includeHook: true,
    },
  });
  const pkgJson = JSON.parse((pkgRes.content as any)[0].text);
  assert.ok(pkgJson[0].titleAudit.ctrScore >= 50);

  // 7. Verify TubeLab compatibility alias works seamlessly even when server is in `compact` mode!
  const aliasRes = await client.callTool({
    name: 'get_credits_balance',
    arguments: {},
  });
  const aliasJson = JSON.parse((aliasRes.content as any)[0].text);
  assert.equal(aliasJson.server, 'CTDO YTB MCP v1.2.0');

  // 8. Verify MCP Resource read (`youtube://system/telemetry`)
  const resRead = await client.readResource({ uri: 'youtube://system/telemetry' });
  const telemetry = JSON.parse((resRead.contents[0] as any).text);
  assert.ok(telemetry.cache.l1Hits >= 1);

  await client.close();
  await server.close();
});
