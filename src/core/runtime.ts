// AgentRuntime: フェーズ1の最重要モジュール。
// LLM 呼び出し → ツール実行 → 結果返却 のメインループを担う。
//
// moco の runtime.py に対応。ここでは @google/genai (新SDK) の Gemini のみをサポートする。
//
// 処理フロー:
//   1. ユーザー入力を受け取る
//   2. Gemini にメッセージを送信（ツール定義も一緒に渡す）
//   3. レスポンスに functionCalls があればツールを実行
//   4. ツール結果を functionResponse として Gemini に返す
//   5. さらに functionCalls があればループ、なければテキストを返して終了

import {
  GoogleGenAI,
  Type,
  Chat,
  Part,
  createPartFromFunctionResponse,
} from '@google/genai';
import { AgentConfig } from '../loader/agent-loader';
import { ToolDefinition } from '../tools/types';
import { LLMError } from '../common/errors';

// ─── ToolCallTracker ────────────────────────────────────────────────────────
// 同一引数のツール呼び出しが繰り返されると無限ループに陥る。
// 「ツール名 + 引数」のキーを Set に記録して重複を検出する。
// moco の ToolCallTracker に対応。
class ToolCallTracker {
  private seen = new Set<string>();

  isDuplicate(name: string, args: unknown): boolean {
    const key = `${name}:${JSON.stringify(args)}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }

  // ユーザーターンが変わるたびにリセットする
  reset(): void {
    this.seen.clear();
  }
}

// ─── 型変換ユーティリティ ───────────────────────────────────────────────────
// ToolDefinition では 'string'/'number' など小文字を使うが、
// Gemini の Schema は Type.STRING / Type.NUMBER など大文字の enum を要求する。
function toGeminiType(type: string): Type {
  const map: Record<string, Type> = {
    string: Type.STRING,
    number: Type.NUMBER,
    boolean: Type.BOOLEAN,
    array: Type.ARRAY,
    object: Type.OBJECT,
  };
  return map[type] ?? Type.STRING;
}

// ─── AgentRuntime ───────────────────────────────────────────────────────────
export class AgentRuntime {
  private chat: Chat;
  private tracker = new ToolCallTracker();
  private tools: ToolDefinition[];

  constructor(
    config: AgentConfig,
    tools: ToolDefinition[],
    model: string = 'gemini-2.0-flash'
  ) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new LLMError(
        'GEMINI_API_KEY environment variable is not set.\n' +
          'Copy .env.example to .env and set your API key.'
      );
    }

    this.tools = tools;

    const ai = new GoogleGenAI({ apiKey });

    // ToolDefinition を Gemini の FunctionDeclaration 形式に変換する。
    // parameters は Schema 型（JSON Schema Object）で渡す。
    const functionDeclarations = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: Type.OBJECT,
        properties: Object.fromEntries(
          Object.entries(tool.parameters.properties).map(([key, param]) => [
            key,
            {
              type: toGeminiType(param.type),
              description: param.description,
              ...(param.enum && { enum: param.enum }),
            },
          ])
        ),
        required: tool.parameters.required,
      },
    }));

    // chats.create() でセッションを開始する。
    // config に tools と systemInstruction を渡すことでセッション全体に適用される。
    // 旧SDK（@google/generative-ai）では getGenerativeModel() + startChat() の2ステップだったが、
    // 新SDK では chats.create() 1ステップに統一されている。
    this.chat = ai.chats.create({
      model,
      config: {
        tools: tools.length > 0 ? [{ functionDeclarations }] : undefined,
        systemInstruction: config.systemPrompt,
      },
    });
  }

  async run(userInput: string): Promise<string> {
    this.tracker.reset();
    return this.executeLoop(userInput);
  }

  // ─── メインループ ─────────────────────────────────────────────────────────
  // ツール呼び出しがなくなるまで繰り返す。
  //
  // 引数の型が string | Part[] なのは:
  //   - 最初のターン: ユーザーのテキスト入力（string）
  //   - 以降のターン: ツール実行結果（Part[] = functionResponse の配列）
  //
  // 旧SDK との違い:
  //   旧: response.response.functionCalls() (メソッド呼び出し)
  //   新: response.functionCalls (プロパティ参照)
  //
  //   旧: response.response.text() (メソッド呼び出し)
  //   新: response.text (プロパティ参照)
  private async executeLoop(input: string | Part[]): Promise<string> {
    let currentInput: string | Part[] = input;

    while (true) {
      // sendMessage の message は PartListUnion = PartUnion[] | PartUnion = Part[] | string
      const response = await this.chat.sendMessage({
        message: currentInput,
      });

      const functionCalls = response.functionCalls;
      if (!functionCalls || functionCalls.length === 0) {
        return response.text ?? '';
      }

      // ツール呼び出しを並列実行する（複数のツールが同時に呼ばれることがある）
      const results: Part[] = await Promise.all(
        functionCalls.map(async (fc) => {
          const name = fc.name ?? '(unknown)';
          const args = fc.args ?? {};

          // 重複呼び出し検出（無限ループ防止）
          if (this.tracker.isDuplicate(name, args)) {
            console.error(`[moco] 重複ツール呼び出しを検出: ${name}`);
            return createPartFromFunctionResponse(fc.id ?? '', name, {
              error: 'Duplicate call - same tool with same arguments was already called.',
            });
          }

          const tool = this.tools.find((t) => t.name === name);
          if (!tool) {
            return createPartFromFunctionResponse(fc.id ?? '', name, {
              error: `Unknown tool: ${name}`,
            });
          }

          // ツール実行をターミナルにログ出力（stderr に出すことでチャット出力と分離する）
          console.error(
            `\x1b[36m[tool]\x1b[0m ${name}(${JSON.stringify(args)})`
          );

          try {
            const output = await tool.execute(args as Record<string, unknown>);
            // createPartFromFunctionResponse は @google/genai が提供するヘルパー関数。
            // functionResponse の Part を正しい形式で生成する。
            return createPartFromFunctionResponse(fc.id ?? '', name, {
              output,
            });
          } catch (e) {
            return createPartFromFunctionResponse(fc.id ?? '', name, {
              error: String(e),
            });
          }
        })
      );

      currentInput = results;
    }
  }
}
