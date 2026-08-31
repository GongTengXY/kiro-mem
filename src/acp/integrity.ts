/**
 * Integrity checks on the isolated KIRO_HOME holding the compressor agent. A
 * drifted layout (file deleted, `tools` populated, prompt missing) breaks the
 * purity assumption, so `startWorker()` and `diagnose` fail loudly here.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface RuntimeHomeIssue {
  severity: 'error' | 'warn';
  message: string;
}

export function checkRuntimeHome(
  kiroHome: string,
  agentName = 'kiro-mem-compressor',
): RuntimeHomeIssue[] {
  const issues: RuntimeHomeIssue[] = [];

  if (!kiroHome) {
    issues.push({ severity: 'error', message: 'runtime kiroHome is not configured' });
    return issues;
  }
  if (!existsSync(kiroHome)) {
    issues.push({ severity: 'error', message: `runtime home does not exist: ${kiroHome}` });
    return issues;
  }

  const agentPath = join(kiroHome, 'agents', `${agentName}.json`);
  if (!existsSync(agentPath)) {
    issues.push({ severity: 'error', message: `agent file missing: ${agentPath}` });
  } else {
    try {
      const cfg = JSON.parse(readFileSync(agentPath, 'utf-8')) as Record<string, unknown>;
      if (cfg.name !== agentName) {
        issues.push({
          severity: 'error',
          message: `agent name mismatch in ${agentPath}: expected "${agentName}", got "${String(cfg.name)}"`,
        });
      }
      const tools = cfg.tools;
      if (!Array.isArray(tools) || tools.length !== 0) {
        issues.push({
          severity: 'error',
          message: `agent ${agentName} must declare tools: [], got ${JSON.stringify(tools)}`,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ severity: 'error', message: `agent file unparseable: ${msg}` });
    }
  }

  // Setup writes the prompt here; the agent JSON references it as
  // file://.../kiro-runtime/<agentName>-prompt.md.
  const promptPath = join(kiroHome, `${agentName}-prompt.md`);
  if (!existsSync(promptPath)) {
    issues.push({ severity: 'error', message: `agent prompt missing: ${promptPath}` });
  }

  return issues;
}

export function formatIssues(issues: RuntimeHomeIssue[]): string {
  return issues
    .map((i) => `  [${i.severity.toUpperCase()}] ${i.message}`)
    .join('\n');
}
