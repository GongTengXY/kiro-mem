#!/usr/bin/env bun
import { existsSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME || "~";
const DATA_DIR = join(HOME, ".kiro-memory");
const AGENT_DIR = join(HOME, ".kiro", "agents");
const SRC_DIR = resolve(import.meta.dir, "../src");

const command = process.argv[2] || "help";

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  case "start": start(); break;
  case "stop": stop(); break;
  default: help();
}

function install() {
  console.log("[kiro-memory] Installing...\n");

  // 1. Check bun
  const bunCheck = spawnSync("bun", ["--version"]);
  if (bunCheck.status !== 0) { console.error("❌ Bun is required. Install: https://bun.sh"); process.exit(1); }
  console.log(`✓ Bun ${bunCheck.stdout.toString().trim()}`);

  // 2. Create directories
  for (const dir of [DATA_DIR, join(DATA_DIR, "hooks"), join(DATA_DIR, "server"), join(DATA_DIR, "logs"), AGENT_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log(`✓ Created ${DATA_DIR}`);

  // 3. Copy hooks
  for (const hook of ["context.sh", "prompt-save.sh", "observation.sh", "summary.sh"]) {
    const src = join(SRC_DIR, "hooks", hook);
    const dst = join(DATA_DIR, "hooks", hook);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
  }
  console.log("✓ Hooks installed");

  // 4. Copy server files
  for (const file of ["worker.ts", "mcp-server.ts"]) {
    copyFileSync(join(SRC_DIR, "server", file), join(DATA_DIR, "server", file));
  }
  for (const file of ["db.ts", "compressor.ts", "queue.ts", "context-builder.ts", "config.ts"]) {
    copyFileSync(join(SRC_DIR, file), join(DATA_DIR, "server", file));
  }
  console.log("✓ Server files installed");

  // 5. Copy prompt
  copyFileSync(join(SRC_DIR, "agent", "prompt.md"), join(DATA_DIR, "prompt.md"));
  console.log("✓ Prompt installed");

  // 6. Create config if not exists
  const configPath = join(DATA_DIR, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      worker: { port: 37778, host: "127.0.0.1", logLevel: "info" },
      compression: { provider: "anthropic", model: "claude-opus-4-6", apiKey: "${ANTHROPIC_API_KEY}", concurrency: 6 },
    }, null, 2));
    console.log("✓ Config created (edit ~/.kiro-memory/config.json to set API key)");
  } else {
    console.log("✓ Config exists (preserved)");
  }

  // 7. Install agent config
  const agentSrc = join(SRC_DIR, "agent", "kiro-memory.json");
  const agentDst = join(AGENT_DIR, "kiro-memory.json");
  copyFileSync(agentSrc, agentDst);
  console.log("✓ Agent config installed");

  // 8. Install node_modules for server (copy package.json + install)
  const serverPkg = join(DATA_DIR, "server", "package.json");
  if (!existsSync(serverPkg)) {
    writeFileSync(serverPkg, JSON.stringify({
      name: "kiro-memory-server", private: true, type: "module",
      dependencies: { hono: "^4.12.0", "@anthropic-ai/sdk": "^0.90.0", "@modelcontextprotocol/sdk": "^1.29.0" },
    }, null, 2));
    const r = spawnSync("bun", ["install"], { cwd: join(DATA_DIR, "server"), stdio: "pipe" });
    if (r.status === 0) console.log("✓ Dependencies installed");
    else console.log("⚠ Dependencies install failed, run: cd ~/.kiro-memory/server && bun install");
  }

  // 9. Start worker
  start();

  console.log("\n✅ kiro-memory installed!");
  console.log("   Set your API key: export ANTHROPIC_API_KEY=sk-...");
  console.log("   Set default agent: kiro-cli settings chat.defaultAgent kiro-memory");
}

function uninstall() {
  stop();
  const agentPath = join(AGENT_DIR, "kiro-memory.json");
  if (existsSync(agentPath)) rmSync(agentPath);
  // 保留数据库，只删除代码文件
  for (const dir of ["hooks", "server"]) {
    const p = join(DATA_DIR, dir);
    if (existsSync(p)) rmSync(p, { recursive: true });
  }
  const prompt = join(DATA_DIR, "prompt.md");
  if (existsSync(prompt)) rmSync(prompt);
  console.log("✅ kiro-memory uninstalled (database preserved at ~/.kiro-memory/kiro-memory.db)");
}

function status() {
  const pidFile = join(DATA_DIR, ".worker.pid");
  if (!existsSync(pidFile)) { console.log("⏹ Worker not running"); return; }
  const pid = readFileSync(pidFile, "utf-8").trim();
  const check = spawnSync("kill", ["-0", pid]);
  if (check.status === 0) {
    const portFile = join(DATA_DIR, ".worker.port");
    const port = existsSync(portFile) ? readFileSync(portFile, "utf-8").trim() : "?";
    console.log(`▶ Worker running (PID: ${pid}, port: ${port})`);
  } else {
    console.log("⏹ Worker not running (stale PID file)");
    rmSync(pidFile);
  }
}

function start() {
  const pidFile = join(DATA_DIR, ".worker.pid");
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, "utf-8").trim();
    const check = spawnSync("kill", ["-0", pid]);
    if (check.status === 0) { console.log(`✓ Worker already running (PID: ${pid})`); return; }
  }
  const worker = join(DATA_DIR, "server", "worker.ts");
  if (!existsSync(worker)) { console.error("❌ Worker not found. Run install first."); return; }
  const proc = Bun.spawn(["bun", "run", worker], {
    cwd: join(DATA_DIR, "server"),
    env: { ...process.env, KIRO_MEMORY_DATA_DIR: DATA_DIR },
    stdio: ["ignore", "ignore", "ignore"],
  });
  proc.unref();
  console.log(`✓ Worker started (PID: ${proc.pid})`);
}

function stop() {
  const pidFile = join(DATA_DIR, ".worker.pid");
  if (!existsSync(pidFile)) return;
  const pid = readFileSync(pidFile, "utf-8").trim();
  spawnSync("kill", [pid]);
  rmSync(pidFile, { force: true });
  console.log("✓ Worker stopped");
}

function help() {
  console.log(`kiro-memory-setup <command>

Commands:
  install     Install kiro-memory
  uninstall   Uninstall (preserves database)
  status      Check worker status
  start       Start worker
  stop        Stop worker`);
}
