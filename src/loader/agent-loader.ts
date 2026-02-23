// エージェントの設定ファイル（Markdown + YAML frontmatter）を読み込むモジュール。
// moco の AgentLoader と AgentConfig に対応する。
//
// エージェント定義の形式:
//   profiles/<profile>/agents/<name>.md
//
//   ---
//   name: orchestrator
//   description: 説明文
//   tools:
//     - read_file
//     - write_file
//   ---
//   ここがシステムプロンプト（Markdownボディ）

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';
import { ConfigError } from '../common/errors';

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[]; // ツール名の配列（getAllTools で解決する）
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

  const { data, content } = matter(raw);

  if (!data.name) {
    throw new ConfigError(
      `Agent file '${agentFile}' is missing 'name' in frontmatter`
    );
  }

  return {
    name: data.name as string,
    description: (data.description as string) ?? '',
    systemPrompt: content.trim(),
    tools: (data.tools as string[]) ?? [],
  };
}

// デフォルトプロファイルのオーケストレーターエージェントを読み込む。
// CLI や単体テスト時のエントリポイントとして使う。
export async function loadDefaultAgent(): Promise<AgentConfig> {
  const profileDir = path.resolve(process.cwd(), 'profiles', 'default');
  return loadAgent(profileDir, 'orchestrator.md');
}
