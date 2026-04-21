import { Hono } from "hono";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";
import { MemoryDB } from "../db";
import { Compressor } from "../compressor";
import { CompressionQueue } from "../queue";
import { buildContext } from "../context-builder";
import { loadConfig, getDataDir } from "../config";

const config = loadConfig();
const db = new MemoryDB();
const compressor = new Compressor();
const queue = new CompressionQueue(db, compressor);

const app = new Hono();
const startTime = Date.now();

// --- Filter ---

function shouldSkip(toolName: string): boolean {
  return config.filter.skipTools.some(pattern => {
    if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
    return toolName === pattern;
  });
}

// --- Routes ---

app.get("/health", (c) =>
  c.json({ status: "ok", version: "1.0.0", uptime: Math.floor((Date.now() - startTime) / 1000), queue_size: queue.size, queue_active: queue.active })
);

app.get("/context", async (c) => {
  const cwd = c.req.query("cwd") || "";
  const limit = Number(c.req.query("limit")) || config.context.maxSessions;
  const text = buildContext(db, cwd, limit, config.context.maxOutputBytes, config.context.includePinned);
  return c.text(text);
});

app.post("/events/prompt", async (c) => {
  const body = await c.req.json();
  const cwd = body.cwd || "";
  const prompt = body.prompt || "";
  if (!prompt) return c.json({ ok: true });

  // 找到或创建 session
  db.abandonStaleSessions(cwd, config.session.timeoutMinutes);
  let session = db.findActiveSession(cwd, config.session.timeoutMinutes);
  if (!session) {
    const repo = detectRepo(cwd);
    session = db.createSession(randomUUID(), cwd, repo || undefined);
  }
  db.appendPrompt(session.id, prompt);
  return c.json({ ok: true, session_id: session.id });
});

app.post("/events/observation", async (c) => {
  const body = await c.req.json();
  const toolName = body.tool_name || "";
  const cwd = body.cwd || "";

  if (shouldSkip(toolName)) return c.json({ ok: true, skipped: true }, 200);

  // 找到 active session
  let session = db.findActiveSession(cwd, config.session.timeoutMinutes);
  if (!session) {
    const repo = detectRepo(cwd);
    session = db.createSession(randomUUID(), cwd, repo || undefined);
  }

  queue.enqueue({
    sessionId: session.id,
    toolName,
    toolInput: body.tool_input,
    toolResponse: body.tool_response,
    cwd,
  });

  return c.json({ ok: true, queued: true }, 202);
});

app.post("/events/stop", async (c) => {
  const body = await c.req.json();
  const cwd = body.cwd || "";
  const assistantResponse = body.assistant_response || "";

  const session = db.findActiveSession(cwd, config.session.timeoutMinutes);
  if (!session) return c.json({ ok: true, no_session: true });

  // 等待该 session 的所有压缩完成
  await queue.waitForSession(session.id);

  // 收集 observations 摘要
  const observations = db.getSessionObservations(session.id);
  const obsSummaries = observations.map(o => o.title || "").filter(Boolean);
  const prompts: string[] = JSON.parse(session.prompts || "[]");

  // 生成 session summary
  const summary = await compressor.compressSession({
    prompts,
    observations: obsSummaries,
    assistant_response: assistantResponse,
  });

  db.completeSession(session.id, {
    request: summary.request,
    investigated: summary.investigated,
    learned: summary.learned,
    completed: summary.completed,
    next_steps: summary.next_steps,
    files_touched: summary.files_touched,
  });

  return c.json({ ok: true, session_id: session.id });
});

// --- Helpers ---

function detectRepo(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {}
  return null;
}

// --- Start ---

export function startWorker() {
  const port = config.worker.port;
  const host = config.worker.host;
  const dataDir = getDataDir();

  // 写入 PID 和 port 文件
  writeFileSync(join(dataDir, ".worker.pid"), String(process.pid));
  writeFileSync(join(dataDir, ".worker.port"), String(port));

  console.log(`[kiro-memory] Worker starting on ${host}:${port}`);

  Bun.serve({ fetch: app.fetch, port, hostname: host });
}

// 直接运行时启动
if (import.meta.main) {
  startWorker();
}
