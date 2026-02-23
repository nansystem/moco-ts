import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolDefinition } from './types';
import { SafetyError } from '../common/errors';

const execAsync = promisify(exec);

// 実行を拒否する危険なコマンドパターン。
// moco の dangerous command 検出に対応。
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//, // ルート以下を全削除
  /mkfs/, // ファイルシステムのフォーマット
  /dd\s+.*of=\/dev/, // デバイスへの直接書き込み
  />\s*\/dev\/(?:sda|sdb|hda)/, // ブロックデバイスの上書き
  /shutdown\s/, // システムのシャットダウン
  /reboot\s/, // システムの再起動
];

export const executeBashTool: ToolDefinition = {
  name: 'execute_bash',
  description:
    'Execute a bash command. Returns stdout and stderr combined. Dangerous commands are blocked.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Bash command to execute' },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
    },
    required: ['command'],
  },
  async execute(args) {
    const { command, timeout = 30000 } = args as {
      command: string;
      timeout?: number;
    };

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        throw new SafetyError(`Dangerous command blocked: ${command}`);
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeout as number,
      });
      return [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
    } catch (e) {
      const err = e as {
        stdout?: string;
        stderr?: string;
        message: string;
        code?: number;
      };
      // コマンドがエラー終了した場合も stderr を返す（エラーメッセージとして有用）
      return `Exit code ${err.code ?? 1}: ${err.stderr || err.message}`;
    }
  },
};
