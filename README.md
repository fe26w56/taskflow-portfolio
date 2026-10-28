# TaskFlow

An AI-first TODO list for people and agents to share work state, progress, and completion evidence.<br>
This public demo runs the core task service locally with fictional data.<br>
It tracks work assigned to agents; it does not run AI agents.

**AIエージェントを人と協働させるための、AIファーストなTODOリスト。**

## 課題：会話の外でも、任せた仕事を追いたい

AIを人と協働する相手として使うとき、依頼を伝えるだけでは足りません。
誰が引き受けたのか、どこまで進んだのか、人の確認を待っているのか。
会話が切り替わったあとも、その状態と完了の根拠を確認できるようにしたいと考えました。

そこで、タスクを単なるチェック項目ではなく、人とAIの受け渡しを記録する単位として扱います。
この公開版では、中核のサービスをローカルSQLiteで動かし、依頼から完了までの状態と記録を試せます。

## 解決のアプローチ：会話ではなく、タスクに状態を残す

状態を変えるルールを`TaskService`に集め、公開デモの画面からも同じサービスを呼び出します。
入力はZodの契約定義で検査し、画面だけで整合性を守る構成にしません。
実装の入口は[`demo/model.ts:5`](demo/model.ts#L5)です。

| 設計の柱 | 実装とねらい | 公開コードの根拠 |
| --- | --- | --- |
| 状態遷移 | AI作業は未着手から引き受け、進行中・確認待ちを経て完了へ。汎用patchによる状態の書き換えを拒否し、専用操作に集約する | [`tasks/index.ts:383`](src/v1/tasks/index.ts#L383) |
| 担当と記録の帰属 | `assigned_agent`で担当、actorで操作主体、`reported_agent`と`attribution`で本人報告・代理報告を区別する。許可された`acting_agent`だけを解決する | [`tasks/index.ts:138`](src/v1/tasks/index.ts#L138)、[`agent-identity.ts:7`](src/v1/auth/agent-identity.ts#L7) |
| 再送の冪等性 | `request_id`と入力のハッシュを保存。同じ依頼は保存済み応答を返し、同じIDで内容を変えると拒否する | [`tasks/index.ts:325`](src/v1/tasks/index.ts#L325) |
| 古い更新の拒否 | `expected_version`が一致しなければ`VERSION_CONFLICT`。読み取り後の競合もDBトリガーで検出し、上書きを防ぐ | [`tasks/index.ts:373`](src/v1/tasks/index.ts#L373)、[`0006_v1_tasks.sql`](migrations/0006_v1_tasks.sql#L29) |
| 根拠付きの完了 | 完了には空でないkindとsummaryが必須。何を確認して終えたかをタスクに残す | [`contracts/index.ts:37`](src/v1/contracts/index.ts#L37)、[`tasks/index.ts:424`](src/v1/tasks/index.ts#L424) |
| 追記型の進捗 | 進捗は別の記録として追記。タスクのversionを進めず、状態更新との不要な競合を避ける | [`tasks/index.ts:160`](src/v1/tasks/index.ts#L160) |

単純にメモ本文を更新し続ける方法に比べ、状態と進捗を分けることで、途中経過を上書きせずに残せます。
更新のたびに最後の書き込みを採用する方法ではなく、競合したら再確認する設計を選んでいます。
これらはコードから説明できる設計上の比較です。【哲さん確認：各代替案を当時どこまで検討したか】

## 工夫したところ：正常系と、止めるべき操作を見せる

### 引き受け → 進捗 → レビュー待ち → 根拠付き完了

進捗を追記してもversionは変わらず、レビュー待ちにすると待機理由が表示されます。
最後は確認結果を入力して完了します。右側には状態変更と進捗が分かれて残ります。
待機は人による承認を強制する仕組みではなく、何を待っているかの記録です。

![架空のタスクを引き受け、進捗を追記し、レビュー待ちから根拠付きで完了する流れ](docs/images/workflow.gif)

### 古い更新と、根拠のない完了を拒否する

「古い更新を試す」は、初期versionでの更新を送ります。
進んだ状態は上書きされず、HTTP 409 / `VERSION_CONFLICT`になります。

![古い更新がVERSION_CONFLICTで拒否され、確認待ちの状態が維持される](docs/images/version-conflict.png)

根拠を空にした完了は`VALIDATION_FAILED`で拒否されます。
公開デモのHTTPサーバーはDomainErrorを一律409に変換します（[`demo/server.ts:20`](demo/server.ts#L20)）。
根拠の記入を必須にするもので、記載内容の正しさを自動判定する機能ではありません。

![根拠なし完了がVALIDATION_FAILEDで拒否される](docs/images/evidence-required.png)

### モバイルでも作業状態を確認する

390×844の画面で、担当・待機理由・状態と操作欄を確認しました。記録は下に続きます。

<img src="docs/images/mobile-390.png" alt="390×844のモバイル画面で架空タスクの完了状態を表示" width="390">

## AIの使い方：実装支援と、人が決めること

| 担当 | 確認できたこと |
| --- | --- |
| 哲さん | 「AIエージェントを人と協働させる」という思想と、AIファーストなTODOリストとして示す方向性を指定。この公開作業では公開範囲、設計の柱、見せる操作、確認基準を指定 |
| Codex（今回） | 公開コードと資料の照合、READMEの構成・執筆、架空データでの画面操作・撮影、テスト再実行、PR作成を担当 |
| 過去のAI支援 | 参照した開発資料には、Claudeが型チェック・ビルド・仕様と差分の自己レビューを担当し、ユーザーが実機で手動確認する検証分担の記録がある。公開版の各実装を誰が書いたかを示す記録ではない |

【哲さん確認：公開版の中核実装でCodex／Claude等が担当した範囲と、哲さん自身が決めた設計・レビューした箇所】

過去の担当範囲を推測で補っていません。抽出範囲と公開用に加えた部分は[来歴](docs/provenance.md)で確認できます。

## 品質の担保

Node.js 24.22.1で再実行し、`npm test`は**33件成功・失敗0件**、`npm run demo`も成功しました。
カバレッジは行**70.62%**・分岐**89.65%**・関数**73.15%**です（下記コマンドのall files、テスト用アダプターも含む集計）。
重複送信、競合、途中失敗時のロールバック、所有者の分離、完了根拠、追記型進捗を検証しています。
[CI](.github/workflows/check.yml)は`npm ci → npm test → npm run demo`を実行する構成です。
画面の操作結果と検証範囲は[動作確認](docs/verification.md)に記録しています。性能・運用効果は未計測です。

## 技術構成と動かし方

TypeScript、Zod、Node.js組み込みSQLiteを使います。Node.js 24とnpmが必要です。
DBやクラウドの契約は不要です。

```sh
npm ci
npm start
```

`http://127.0.0.1:4174`を開き、「仕事を引き受ける」「進捗を記録」「レビュー待ちにする」の順に操作します。
「完了の根拠」に確認結果を入力して「根拠を添えて完了」を押します。

```sh
npm test
node --test --experimental-test-coverage tests/*.test.ts
npm run demo
```

`npm run demo`は一連の操作を実行し、`output/scenario.json`へ結果を書き出します。
独立したビルドスクリプトはなく、Node.jsがTypeScriptを直接実行します。

### 公開版の範囲と注意

**タスクと担当者は架空です。画像・GIFも架空データの操作例です。**
デモのDBはメモリ内に作り、プロセスを終了すると消えます。
AIを実行する機能や、運用環境への接続はありません。

公開版には`TaskService`、契約定義、DB層、関連するマイグレーションとテストを含めています。
運用版の画面、OAuthサーバー、HTTP・MCPの配信処理、デプロイ設定は含みません。
外部通知用のコードは依存する型を保つために残していますが、デモでは生成・実行しません。
公開デモのHTTPサーバーはローカル確認用で、運用向けの認証を備えていません。

コードを読む入口は[`TaskService`](src/v1/tasks/index.ts)と[AI作業の失敗ケースのテスト](tests/v1-agent-work.test.ts)です。
[変更前のREADME](docs/readme-original.md)／[来歴](docs/provenance.md)／[動作確認](docs/verification.md)も参照できます。
