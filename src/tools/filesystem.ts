import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ToolDefinition } from './types';
import { ToolError, SafetyError } from '../common/errors';

// パスを現在のワーキングディレクトリからの絶対パスに解決する。
// moco の resolve_safe_path に対応。
function resolveSafePath(filePath: string): string {
  return path.resolve(process.cwd(), filePath);
}

// ─── read_file ─────────────────────────────────────────────────────────────
// `cat -n` のように行番号付きで読み込む。
// 大きなファイルは offset/limit で分割して読める。
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a file with line numbers. Use offset/limit to read large files in sections.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
      offset: {
        type: 'number',
        description: 'Start line number (1-indexed, default: 1)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read (default: 200)',
      },
    },
    required: ['path'],
  },
  async execute(args) {
    const {
      path: filePath,
      offset = 1,
      limit = 200,
    } = args as { path: string; offset?: number; limit?: number };

    const content = await fs.readFile(resolveSafePath(filePath), 'utf-8');
    const lines = content.split('\n');
    const start = (offset as number) - 1;
    const end = Math.min(start + (limit as number), lines.length);

    return lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join('\n');
  },
};

// ─── write_file ────────────────────────────────────────────────────────────
// 既存ファイルが5行超の場合、overwrite=true を要求する安全ガード。
// LLM が誤って既存ファイルを丸ごと上書きするミスを防ぐ。
export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write content to a file. For existing files with more than 5 lines, set overwrite=true to confirm.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
      overwrite: {
        type: 'boolean',
        description:
          'Set to true to overwrite existing files with more than 5 lines (default: false)',
      },
    },
    required: ['path', 'content'],
  },
  async execute(args) {
    const {
      path: filePath,
      content,
      overwrite = false,
    } = args as { path: string; content: string; overwrite?: boolean };
    const resolved = resolveSafePath(filePath);

    try {
      const existing = await fs.readFile(resolved, 'utf-8');
      const lineCount = existing.split('\n').length;
      if (!overwrite && lineCount > 5) {
        throw new SafetyError(
          `File '${filePath}' already has ${lineCount} lines. Set overwrite=true to confirm overwriting.`
        );
      }
    } catch (e) {
      // ENOENT = ファイルが存在しない → 新規作成なので OK
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content as string, 'utf-8');
    return `Successfully wrote to ${filePath}`;
  },
};

// ─── edit_file ─────────────────────────────────────────────────────────────
// ファイルの一部を検索・置換する。
// まず完全一致を試み、失敗した場合はインデント(行頭空白)を無視してマッチを試みる。
// これにより LLM がインデントを微妙に間違えても動作しやすくなる。
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description:
    'Replace a specific section of text in a file. Searches for the exact text (whitespace-tolerant) and replaces it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit' },
      find: {
        type: 'string',
        description: 'Text to find (can be multi-line)',
      },
      replace: { type: 'string', description: 'Text to replace with' },
    },
    required: ['path', 'find', 'replace'],
  },
  async execute(args) {
    const { path: filePath, find, replace } = args as {
      path: string;
      find: string;
      replace: string;
    };
    const resolved = resolveSafePath(filePath);
    let content = await fs.readFile(resolved, 'utf-8');

    // ① 完全一致
    if (content.includes(find)) {
      content = content.replace(find, replace);
      await fs.writeFile(resolved, content, 'utf-8');
      return `Successfully edited ${filePath}`;
    }

    // ② 各行の先頭空白を無視したスマートマッチ
    const contentLines = content.split('\n');
    const findLines = (find as string).trim().split('\n').map((l) => l.trim());

    for (let i = 0; i <= contentLines.length - findLines.length; i++) {
      const chunk = contentLines
        .slice(i, i + findLines.length)
        .map((l) => l.trim());
      if (chunk.join('\n') === findLines.join('\n')) {
        const before = contentLines.slice(0, i);
        const after = contentLines.slice(i + findLines.length);
        const newLines = [
          ...before,
          ...(replace as string).split('\n'),
          ...after,
        ];
        await fs.writeFile(resolved, newLines.join('\n'), 'utf-8');
        return `Successfully edited ${filePath}`;
      }
    }

    throw new ToolError(
      `Could not find the specified text in '${filePath}'. Make sure the text exists exactly as specified.`
    );
  },
};
