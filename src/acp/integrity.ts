/**
 * Runtime home integrity checks for the internal compressor agent.
 *
 * The kiro-mem ACP runtime relies on a hand-installed isolated KIRO_HOME
 * that contains exactly one purpose-built agent. Once installed it should be
 * treated as a contract; if anything in there drifts (file deleted, tools
 * field accidentally populated, prompt missing), the purity assumption no
 * longer holds. These checks let `startWorker()` and `diagnose` fail loudly
 * before we ever spawn a runtime against a broken layout.
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

  // Setup writes the prompt at kiroHome/<agentName>-prompt.md (the agent JSON
  // references it as file://.../kiro-runtime/<agentName>-prompt.md).
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
