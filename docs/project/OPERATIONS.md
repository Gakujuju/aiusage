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

- `pnpm -r test` の widget 1件（`resolves the widget-specific native sqlite
  binding path`）は Windows のパス区切りに起因する既存の失敗。本件とは無関係。
- CLI のテストは `loadConfig()` を通じて実 `~/.aiusage/config.json` を読む。
  設定に依存するテストは、実機の状態に左右されないようモジュールをモックする
  （`tests/notify/discord.test.ts` が例）。

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

## ユーザー環境

- `~/.claude/settings.json` は自動で書き換えない。
  Phase 7 の hook 追記は明示承認を得て実施済み。
  変更する場合は必ず事前にバックアップし、保存前に
  「既存 command 文字列が1つも変化していないこと」を検証する。
  （壊れた settings.json は Claude Code 全体を止める。前例あり）
- 本番DB のパスは `~/.aiusage/cache.db`。`aiusage.db` ではない。
- Discord webhook は `config.credentials.discordWebhook` に置く。
  `notifications` セクションには置かない。API は設定済みか否かだけを返す。
  エラー文言は保存・ログ出力の前に URL をマスクする（`maskUrls`）。
