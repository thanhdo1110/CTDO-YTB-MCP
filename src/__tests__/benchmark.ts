import { getToolsForMode } from '../tools/definitions.js';
import { dispatchToolCall } from '../tools/router.js';
import { globalCache } from '../core/cache.js';

function estimateTokens(str: string): number {
  return Math.ceil(str.length / 4);
}

async function runBenchmark() {
  console.log('================================================================');
  console.log('⚡ CTDO YTB MCP — Tool Weight & Runtime Speed Benchmark');
  console.log('================================================================\n');

  // 1. Schema Token Weight Benchmark
  const liteJson = JSON.stringify(getToolsForMode('lite'));
  const compactJson = JSON.stringify(getToolsForMode('compact'));
  const fullJson = JSON.stringify(getToolsForMode('full'));

  console.log('1️⃣  MCP Tool Schema Context Weight (Lower = Faster & Cheaper LLM Turns):');
  console.log(`   • lite mode    ( 4 tools): ${liteJson.length.toLocaleString()} bytes (~${estimateTokens(liteJson).toLocaleString()} tokens)`);
  console.log(`   • compact mode (12 tools): ${compactJson.length.toLocaleString()} bytes (~${estimateTokens(compactJson).toLocaleString()} tokens) [DEFAULT — 100% Features]`);
  console.log(`   • full mode    (40 tools): ${fullJson.length.toLocaleString()} bytes (~${estimateTokens(fullJson).toLocaleString()} tokens)\n`);

  // 2. Cold vs Warm Cache Latency Benchmark (Live YouTube InnerTube 0-API-key)
  globalCache.clear();

  const t0 = performance.now();
  const coldVideo = await dispatchToolCall('yt_videos', {
    videos: ['dQw4w9WgXcQ'],
    includeChapters: true,
    includeSponsorBlock: true,
    includeDislikes: true,
  });
  const coldVideoMs = performance.now() - t0;

  const t1 = performance.now();
  await dispatchToolCall('yt_videos', {
    videos: ['dQw4w9WgXcQ'],
    includeChapters: true,
    includeSponsorBlock: true,
    includeDislikes: true,
  });
  const warmVideoMs = performance.now() - t1;

  const t2 = performance.now();
  const coldTx = await dispatchToolCall('yt_transcript', {
    videos: ['dQw4w9WgXcQ'],
    mode: 'key_segments',
  });
  const coldTxMs = performance.now() - t2;

  const t3 = performance.now();
  await dispatchToolCall('yt_transcript', {
    videos: ['dQw4w9WgXcQ'],
    mode: 'key_segments',
  });
  const warmTxMs = performance.now() - t3;

  console.log('2️⃣  Live Latency (Cold Network vs L1/SQLite Cache Hit):');
  console.log(`   • yt_videos (+SB +Dislikes): Cold = ${coldVideoMs.toFixed(1)} ms  |  Warm Cache = ${warmVideoMs.toFixed(3)} ms  (Payload: ~${estimateTokens(coldVideo.text)} tokens)`);
  console.log(`   • yt_transcript (hook/CTA) : Cold = ${coldTxMs.toFixed(1)} ms  |  Warm Cache = ${warmTxMs.toFixed(3)} ms  (Payload: ~${estimateTokens(coldTx.text)} tokens)\n`);

  console.log('3️⃣  Cache Telemetry:');
  console.log('  ', JSON.stringify(globalCache.getTelemetry()));
  console.log('\n✅ Benchmark completed successfully!');
}

runBenchmark().catch((err) => {
  console.error(err);
  process.exit(1);
});
