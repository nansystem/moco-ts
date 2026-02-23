// ツールの型定義。
// Gemini の FunctionDeclaration と対応させるため、JSONスキーマに近い構造にしている。

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  items?: { type: string }; // array の要素型
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  // 実際のツール実行関数。LLM から渡された args を受け取り、結果を文字列で返す。
  execute: (args: Record<string, unknown>) => Promise<string>;
}
