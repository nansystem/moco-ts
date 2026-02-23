// 最小限の対話型 CLI。
// readline で標準入力を読み取り、AgentRuntime に渡す。
//
// 使い方:
//   pnpm dev
//   または
//   GEMINI_API_KEY=xxx tsx src/cli.ts

import 'dotenv/config'; // .env ファイルから環境変数を読み込む
import * as readline from 'node:readline';
import { loadDefaultAgent } from './loader/agent-loader';
import { getToolsByName } from './tools/index';
import { AgentRuntime } from './core/runtime';

async function main() {
  let runtime: AgentRuntime;

  try {
    const config = await loadDefaultAgent();
    const tools = getToolsByName(config.tools);
    runtime = new AgentRuntime(config, tools);

    console.log(`\x1b[32mmoco-ts\x1b[0m agent: ${config.name}`);
    console.log(
      `tools: ${tools.map((t) => t.name).join(', ') || '(none)'}`
    );
    console.log('Type "exit" to quit.\n');
  } catch (e) {
    console.error(`Failed to initialize: ${e}`);
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const input = await question('You: ');

    if (input.toLowerCase() === 'exit') break;
    if (!input.trim()) continue;

    try {
      const response = await runtime.run(input);
      console.log(`\nAssistant: ${response}\n`);
    } catch (e) {
      console.error(`\nError: ${e}\n`);
    }
  }

  rl.close();
  console.log('Goodbye!');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
