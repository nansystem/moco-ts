// moco のエラー階層。MocoError を基底クラスとして、用途別に派生させる。
// catch 節で `instanceof ToolError` のように種別判定できるのがメリット。

export class MocoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

// ツール実行中に発生するエラー（ファイルが見つからない、など）
export class ToolError extends MocoError {}

// LLM API 呼び出し時のエラー（認証失敗、レート制限、など）
export class LLMError extends MocoError {}

// エージェント設定ファイルのパースエラー
export class ConfigError extends MocoError {}

// 危険な操作をブロックするエラー（rm -rf /、大きなファイルの上書き、など）
export class SafetyError extends MocoError {}
