import { readFileTool, writeFileTool, editFileTool } from './filesystem';
import { executeBashTool } from './bash';
import { ToolDefinition } from './types';

export const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  executeBashTool,
];

// 名前リストから ToolDefinition を取得する。
// AgentConfig.tools の文字列配列をランタイムに解決するために使う。
export function getToolsByName(names: string[]): ToolDefinition[] {
  return names
    .map((name) => ALL_TOOLS.find((t) => t.name === name))
    .filter((t): t is ToolDefinition => t !== undefined);
}

export type { ToolDefinition } from './types';
