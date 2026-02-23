# moco-ts 処理フロー

## ディレクトリ構成と役割

```
src/
├── cli.ts                  # エントリポイント。readline でユーザー入力を受け取る
├── common/
│   └── errors.ts           # エラー階層の定義
├── loader/
│   └── agent-loader.ts     # Markdown ファイルからエージェント設定を読み込む
├── tools/
│   ├── types.ts            # ToolDefinition インターフェース
│   ├── filesystem.ts       # read_file / write_file / edit_file
│   ├── bash.ts             # execute_bash
│   └── index.ts            # ツール一覧・名前解決
└── core/
    └── runtime.ts          # AgentRuntime（LLM ↔ ツールのメインループ）

profiles/
└── default/
    └── agents/
        └── orchestrator.md # エージェント定義（frontmatter + システムプロンプト）
```

---

## 起動フロー

```
pnpm dev
  │
  ▼
cli.ts: main()
  │
  ├─ loadDefaultAgent()
  │    └─ profiles/default/agents/orchestrator.md を読み込む
  │         gray-matter で frontmatter をパース
  │         → AgentConfig { name, description, systemPrompt, tools: string[] }
  │
  ├─ getToolsByName(config.tools)
  │    └─ ["read_file", "write_file", "edit_file", "execute_bash"]
  │         → ToolDefinition[] に解決
  │
  └─ new AgentRuntime(config, tools)
       │
       ├─ new GoogleGenAI({ apiKey })
       │
       ├─ ToolDefinition[] → FunctionDeclaration[] に変換
       │    type: 'string' → Type.STRING（Gemini の enum に合わせる）
       │
       └─ ai.chats.create({ model, config: { tools, systemInstruction } })
            チャットセッション開始。履歴は SDK が内部管理する。
```

---

## ユーザー入力の処理フロー（1ターン）

```
You: "package.jsonを読んで"
  │
  ▼
runtime.run(userInput)
  │
  ├─ tracker.reset()  ← ToolCallTracker をリセット（無限ループ検出用 Set をクリア）
  │
  └─ executeLoop(userInput)  ← メインループ開始
```

---

## executeLoop の詳細（ツール呼び出しあり）

```
executeLoop("package.jsonを読んで")
  │
  ▼
chat.sendMessage({ message: "package.jsonを読んで" })
  │
  │  Gemini はメッセージとツール定義を受け取り、
  │  どのツールを使うべきか判断する
  │
  ▼
response.functionCalls = [
  { id: "xxx", name: "read_file", args: { path: "package.json" } }
]
  │
  ├─ functionCalls あり → ツール実行へ
  │
  ▼
Promise.all(functionCalls.map(fc => ...))  ← 複数ツールは並列実行
  │
  ├─ tracker.isDuplicate("read_file", { path: "package.json" })
  │    → false（初回なので通過）
  │    → キー "read_file:{"path":"package.json"}" を Set に記録
  │
  ├─ tools.find(t => t.name === "read_file")
  │    → readFileTool を発見
  │
  ├─ [stderr] [tool] read_file({"path":"package.json"})
  │
  └─ readFileTool.execute({ path: "package.json" })
       │
       ├─ resolveSafePath("package.json") → /abs/path/package.json
       ├─ fs.readFile(...)
       └─ 行番号付きで返す:
            "1\t{\n2\t  \"name\": \"moco-ts\"\n..."
  │
  ▼
results = [
  createPartFromFunctionResponse("xxx", "read_file", { output: "1\t{..." })
]
  │  ↑ @google/genai のヘルパーで functionResponse Part を生成
  │
  ▼
currentInput = results  ← 次のループへ

────────────── ループ2周目 ──────────────

chat.sendMessage({ message: results })
  │
  │  Gemini はツール結果を受け取り、
  │  最終的なテキスト回答を生成する
  │
  ▼
response.functionCalls = undefined（またはlength=0）
  │
  └─ return response.text
       → "package.jsonの内容は ..." （テキスト回答）

────────────── ループ終了 ──────────────
  │
  ▼
cli.ts: console.log(`Assistant: ${response}`)
```

---

## ToolCallTracker による無限ループ防止

```
LLM が同じツールを同じ引数で繰り返し呼ぼうとした場合:

1周目: read_file({ path: "foo.txt" }) → Set に追加 → 実行
2周目: read_file({ path: "foo.txt" }) → Set に既存 → エラー返却
  └─ functionResponse: { error: "Duplicate call - ..." }

Gemini はエラーを受け取り、別の判断をする（または終了する）
```

---

## write_file の安全ガード

```
write_file({ path: "big.ts", content: "...", overwrite: false })
  │
  ├─ 既存ファイルを読み込む
  │    ├─ ENOENT（存在しない） → そのまま書き込み OK
  │    └─ 存在する → 行数をカウント
  │         ├─ 5行以下 → 書き込み OK
  │         └─ 6行以上 + overwrite=false → SafetyError を throw
  │              └─ LLM に "overwrite=true が必要" と伝わる
  │
  └─ fs.writeFile(...)
```

---

## edit_file のスマートマッチ

```
edit_file({ path: "foo.ts", find: "  const x = 1", replace: "  const x = 2" })
  │
  ├─ ① 完全一致で content.includes(find) を試みる
  │    → 一致 → replace して保存
  │
  └─ ② 不一致の場合、各行の先頭空白を trim してから比較
       インデントが多少ズレていても検索できる
       → 一致した行範囲を before / after に分割して replace を挿入
       → 不一致 → ToolError を throw
```

---

## エラー階層

```
Error (JS標準)
└── MocoError
    ├── ToolError    ファイル操作の失敗、検索文字列が見つからない
    ├── LLMError     APIキー未設定、認証失敗
    ├── ConfigError  エージェント設定ファイルの不備
    └── SafetyError  危険コマンドのブロック、大きなファイルの上書き防止
```

`instanceof` で種別判定できるため、将来エラー別のリトライ処理なども書きやすい。

---

## Gemini SDK の会話履歴管理

`ai.chats.create()` で作成した `Chat` オブジェクトは会話履歴を内部で保持する。

```
ターン1: sendMessage("package.jsonを読んで")
  → 内部履歴: [user: "package.jsonを読んで"]

ターン1 ツール: sendMessage([functionResponse])
  → 内部履歴: [user: "...", model: functionCall, user: functionResponse]

ターン1 応答: "package.jsonの内容は..."
  → 内部履歴: [..., model: "package.jsonの内容は..."]

ターン2: sendMessage("次に...")
  → 内部履歴: 上記すべて + user: "次に..."
```

これにより前の会話を覚えた状態で続きの質問ができる。

---

## データの流れ（型で見る）

```
cli.ts
  string (ユーザー入力)
    ↓
AgentRuntime.run(string)
    ↓
executeLoop(string | Part[])  ← ループ内で型が切り替わる
    ↓
chat.sendMessage({ message: string | Part[] })
    ↓
GenerateContentResponse
  .functionCalls → FunctionCall[] | undefined
  .text          → string | undefined
    ↓
tool.execute(Record<string, unknown>)
    ↓
string (ツール実行結果)
    ↓
createPartFromFunctionResponse(id, name, { output: string })
    ↓
Part[] → 次のループの入力へ
```
