// エージェントの設定ファイル（純粋YAML）を読み込むモジュール。
// moco の AgentLoader と AgentConfig に対応する。
//
// エージェント定義の形式:
//   profiles/<profile>/agents/<name>.yaml
//
//   name: orchestrator
//   description: 説明文
//   tools:
//     - read_file
//     - write_file
//   system_prompt: |
//     システムプロンプト本文

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../common/errors';

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[]; // ツール名の配列（getToolsByName で解決する）
}

export async function loadAgent(
  profileDir: string,
  agentFile: string
): Promise<AgentConfig> {
  const filePath = path.resolve(profileDir, 'agents', agentFile);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new ConfigError(`Agent file not found: ${filePath}`);
  }

  // takt と同様に parseYaml() に直接渡す
  const data = parseYaml(raw) as Record<string, unknown>;

  if (!data.name) {
    throw new ConfigError(
      `Agent file '${agentFile}' is missing 'name' field`
    );
  }

  return {
    name: data.name as string,
    description: (data.description as string) ?? '',
    systemPrompt: ((data.system_prompt as string) ?? '').trim(),
    tools: (data.tools as string[]) ?? [],
  };
}

export async function loadDefaultAgent(): Promise<AgentConfig> {
  const profileDir = path.resolve(process.cwd(), 'profiles', 'default');
  return loadAgent(profileDir, 'orchestrator.yaml');
}
