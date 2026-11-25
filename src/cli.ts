#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolWeightMode } from './core/types.js';
import { CTDO_VERSION, startHttpMcpServer, startStdioMcpServer } from './server.js';

// Zero-dependency lightweight .env loader (saves dotenv package bloat!)
function loadDotEnvIfPresent() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // ignore
  }
}

async function main() {
  loadDotEnvIfPresent();

  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(CTDO_VERSION);
    process.exit(0);
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`CTDO YTB MCP v${CTDO_VERSION} — Ultra-Fast High-Performance YouTube MCP Server

Usage:
  ctdo-ytb-mcp [options]

Options:
  --mode=lite|compact|full   Tool schema weight mode (default: compact)
  --http                     Start StreamableHTTP server instead of stdio
  --port=8088                HTTP port when --http is active
  --host=127.0.0.1           HTTP bind host
  -v, --version              Print version
  -h, --help                 Show help
`);
    process.exit(0);
  }

  const modeArg = argv.find((a) => a.startsWith('--mode='))?.split('=')[1] as ToolWeightMode | undefined;
  if (modeArg) process.env.CTDO_TOOL_MODE = modeArg;

  const isHttp = argv.includes('--http') || (process.env.MCP_TRANSPORT || '').toLowerCase() === 'http';
  const portArg = argv.find((a) => a.startsWith('--port='))?.split('=')[1];
  const hostArg = argv.find((a) => a.startsWith('--host='))?.split('=')[1];

  if (isHttp) {
    await startHttpMcpServer({
      host: hostArg,
      port: portArg ? Number(portArg) : undefined,
      mode: modeArg,
    });
  } else {
    await startStdioMcpServer(modeArg);
  }
}

main().catch((err) => {
  console.error('[CTDO YTB MCP] Fatal startup error:', err);
  process.exit(1);
});
