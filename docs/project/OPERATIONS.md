# 運用ルール

このプロジェクト（AI 総合通知・利用料把握システム）の作業規約。
違反すると実データを壊すか、後戻りできなくなるものだけを列挙する。

## 検証環境

- 検証は必ず `AIUSAGE_HOME` で隔離ディレクトリを使う。
  本番DB `~/.aiusage/cache.db` に検証用データを投入しない。
  実データと検証データが混ざると durations と p90 の統計が汚れる。
- `USERPROFILE` を偽装する旧手法は使わない（`AIUSAGE_HOME` で足りる）。
- `.claude/launch.json` はラッパー `.claude/dev-server.mjs` 経由で
  `AIUSAGE_HOME=<repo>/.dev-aiusage`、ポート 4847 を使う。
  本番は 3847。これを混ぜると本番DBが意図せずマイグレーションされる（実際に一度起きた）。

## バックアップ

- 常に2世代を保つ。
  ① `backup-v12-20260829/`  プロジェクト開始前のスナップショット
  ② 直近の安定状態
- ①は Phase 7 の運用が安定した時点で削除する。
- バックアップは `cache.db` / `cache.db-wal` / `cache.db-shm` / `config.json` の4点。
  `-wal` と `-shm` を欠くと不整合なコピーになる。
- 取得前に serve とプレビューサーバが停止していることを確認する。

## コードの直し方

- Phase 6 以降に我々が書いたコードのバグ → 確認を待たず直してよい。
  別コミット＋回帰テスト＋報告は必須。
- upstream 由来の既存コードのバグ → 直す前に報告する。
  挙動変更が既存データの解釈に影響するため。

## Git

- push 前に必ず `git remote -v` で origin が Gakujuju/aiusage のみであることを確認する。
  upstream（juliantanx/aiusage）への誤爆は取り返しがつかない。
- `.gitignore` は変更しない。upstream との差分になり将来のマージで衝突する。
  ローカル除外は `.git/info/exclude` を使う。
- `pnpm -r lint` は存在しない（ルートに定義があるだけで実体なし）。
  型チェックは `tsc --noEmit` で行い、main 比の新規エラー0件を確認する。
  現在の既定エラーは6件（`api/server.ts` の pricing alias、`clean.ts` の
  backend union、`parse-kilo.ts` / `parse-opencode.ts` の undefined）。
  これらは upstream 由来で、増えていないことだけを確認する。

## テスト

- `pnpm -r test` は widget の既知失敗で中断し、後続パッケージが
  実行されない。core / cli / web は個別に実行して確認すること。
  完了条件として「pnpm -r test 緑」と書かれていた場合は
  「core / cli / web が個別に緑」と読み替えてよい。
- widget の既知失敗は 1件（`resolves the widget-specific native sqlite
  binding path`）で、Windows のパス区切りに起因する。個別の変更とは無関係。
- widget のテストは実行前に better-sqlite3 をリビルドするため、
  本番 serve が動いていると .node ファイルがロックされて EBUSY で失敗する。
  widget を確認したいときは serve を止めてから実行する。
- CLI のテストは `loadConfig()` を通じて実 `~/.aiusage/config.json` を読む。
  設定に依存するテストは、実機の状態に左右されないようモジュールをモックする
  （`tests/notify/discord.test.ts` が例）。

## パッケージ間のビルド順序

cli のテストは @aiusage/core のビルド済み dist を参照する。
core を変更しても再ビルドするまで cli のテストには反映されず、
落ちるべきテストが通る。実際に quotaThresholdCrossings の期待値誤りが
1フェーズ分隠れていた（出荷済みの挙動は正しく、誤っていたのは期待値だけ）。

packages/cli/package.json の pretest が core をビルドするので
通常は意識しなくてよい。ただし個別に vitest を直接叩く場合は
pretest が走らないため、core を触った直後は
  pnpm --filter @aiusage/core build
を先に実行すること。

packages/site は別の解き方をしていて、vitest.config.ts で
`@aiusage/core` を `../core/src/index.ts` にエイリアスしている。
ビルドが要らない代わりに、出荷されるバンドルではなくソースを
テストすることになる。cli は出荷物と同じものをテストしたいので
pretest を選んだ。どちらでもよいが、両方やらない状態が最悪。

web と widget は core を参照していない
（web は TOOLS を手で写した定数を持っている。これはこれで
  ずれる余地があるが、ビルド順序の問題ではない）。

## 検証条件の書き方

「この分岐は安全なので通す」という判断は、判断そのものを引数か
戻り値にして、テストから直接呼べる形にする。
`checkHostSafety(host, env)` と `shouldProtectApiPath(path, isLoopback)`
がその形になっている。

避けたいのは、条件が `serve()` の途中や `if` の奥に埋まっていて、
確かめるのにサーバを実際に起動しなければならない状態。
そうなると誰も確かめず、条件が静かに壊れる。

- 環境変数は `process.env` を直接読まず、既定値付きの引数で受ける
  （`env: NodeJS.ProcessEnv = process.env`）。テストで差し替えられる。
- 真偽値の既定値は「既存の呼び出し側が今までどおり動く」向きに置く
  （`isLoopback = true`）。移行中に意図しない締め付けが起きない。
- 拒否するときのメッセージには必ず回避手段を書く。
  回避手段の無い拒否は、ユーザーには単なる故障に見える。
- 逃げ道の環境変数は厳密一致で判定する（`=== '1'`）。
  truthy 判定にすると `'0'` や `'false'` で開いてしまう。

## 引数の検証は副作用の前に行う

コマンドの引数が不正で起動を拒否する場合、その判定は
DB を開くより前に行う。createDatabase は runMigrations を伴うため、
「拒否したのに本番DBだけマイグレーションされている」状態を作りうる。

serve --host の安全確認をこの順序に直した経緯がある（D16 関連）。
新しいコマンドやオプションを足すときも同じ順序を守ること。

## 調査で CLI のエントリを実行しない

`node -e "require('.../dist/index.js')"` のような調査は、
CLI の既定動作を走らせるのと同じで、AIUSAGE_HOME を設定していなければ
本番DBを開き runMigrations まで到達する。実際に v19 がこの経路で
本番に適用された（指示役も同じ操作をしていた）。

調査は以下のいずれかで行う:
  ・packages/cli/tests 配下に一時テストを置いて vitest で走らせる
  ・AIUSAGE_HOME を設定した隔離環境で実行する
  ・better-sqlite3 で readonly: true を指定して直接開く

マイグレーションは適用時に
  [migration] applying vN to <path>
を出すので、誤って本番を開いた場合はその場で気づける。

## ユーザー環境

- `~/.claude/settings.json` は自動で書き換えない。
  Phase 7 の hook 追記は明示承認を得て実施済み。
  現在の sha256 は bbfbead44827f015（2026-08-30、案A の CLI ログイン後）。
  CLI ログインは theme キーを1つ追加するだけで hooks を壊さない。
  8イベント・12エントリすべて無傷で、既存 PowerShell hook と
  aiusage hook の両方が残っていることを実測確認した。
  変更する場合は必ず事前にバックアップし、保存前に
  「既存 command 文字列が1つも変化していないこと」を検証する。
  （壊れた settings.json は Claude Code 全体を止める。前例あり）
- 本番DB のパスは `~/.aiusage/cache.db`。`aiusage.db` ではない。
- Discord webhook は `config.credentials.discordWebhook` に置く。
  `notifications` セクションには置かない。API は設定済みか否かだけを返す。
  エラー文言は保存・ログ出力の前に URL をマスクする（`maskUrls`）。
