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

## 開発サーバは外部 API を叩かない

開発サーバと本番サーバが同時に動くと、両方が同じクォータ
エンドポイントを叩き、レート制限（429）に当たる。
実際に 8-A-1 の検証中に発生し、本番の quota_current に
取得失敗が記録された。

.dev-aiusage/config.json では
  quotaSnapshotInterval: 0
  notifications.enabled: false
を設定する。本番DBをコピーし直すと config も上書きされるので、
dev-server.mjs が起動時に検査して警告を出す。

credentials（Discord webhook）も同じ経路で入ってくるので、
コピー後は削除する。dev-server.mjs はこれも検査する。

quotaSnapshotInterval: 0 は定期ポーリングだけでなく
起動時の1回も止める（serve 側を修正済み）。

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

## 翻訳が無いキーは英語で出る

t() は現在のロケールにキーが無ければ en にフォールバックする。
生のキー（"quotas.forecast.pace"）が画面に出ることは構造的に無い。

追加する文言は en / ja / zh の3ロケールすべてに入れるのが原則。
ただし zh を埋められない場合はフォールバックに任せてよい。
英語で出るのは欠落であって不具合ではない。

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

本番 serve を再起動する前は、リポジトリのルートで
  pnpm build
を実行すること。ルートの build スクリプトが core → web → cli の順に
ビルドする。cli だけをビルドすると古い core の dist を取り込む。

実際に、段階3 の前提を実装した直後の再起動で古い dist を掴み、
本番通知が旧実装の出力（応答が ``` から始まる／エイリアス未適用）に
なった。テストは pretest で守られているが、デプロイは守られていない。

再起動後は、実際に出た通知の内容で新しいビルドが動いていることを
確認すること。プロセスが起動したことは、新しいコードが動いている
証拠にならない。

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

### 観測で示せないものは構造で示す

「本番に触れていない」を、動いているシステムの観測で示そうとしない。
本番 serve は5分ごとにクォータを書き、hook は作業中のセッションから
毎ターン agent イベントを POST する。作業と無関係に DB は変わり続ける。

誤った条件の例（実際に2回使ってしまった）:

- 「totalTokens が適用前後で一致すること」
  JSONL は serve が動く限り増え続ける。静止させない限り一致しない。
- 「本番DBの mtime が変わっていないこと」
  本番 serve と hook が常に書き込む。しかも WAL のせいで本体ファイルの
  更新が遅れ、一度は「変わっていない」ように見えることがある。
  偶然の一致を証拠と読んでしまうので、無いよりかえって危険。

正しい条件の例:

- schema_version が増えていない（マイグレーションを適用していない）
- 検証コマンドがすべて AIUSAGE_HOME=<repo>/.dev-aiusage 配下で実行されている
- DB を加工するスクリプトが、パスに '.dev-aiusage' を含まなければ
  throw するガードを持っている
- 本番パスを引数に取ったコマンドを実行していない

前者は「結果を見て、たぶん大丈夫」。後者は「そもそも到達できない」。
到達できないことを示せる場合は、必ずそちらを使う。

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

## serve の起動と停止

ログオン時にタスクスケジューラが起動する。手で起動する必要はない。

  タスク名   : aiusage-serve
  実行するもの: %USERPROFILE%\.aiusage\start-serve.cmd
  ログ       : %USERPROFILE%\.aiusage\serve.log（追記）

バインド先は config.host（現在 127.0.0.1,100.82.102.59）。
start-serve.cmd に --host は書かれていない。

手で操作する:

  今すぐ起動   schtasks /Run /TN aiusage-serve
  止める       Stop-Process -Name node の対象を絞るか、
               タスクマネージャで該当の node を終了する
  ログを見る   Get-Content "$env:USERPROFILE\.aiusage\serve.log" -Tail 30
  状態を見る   schtasks /Query /TN aiusage-serve

タスクを消す:

  schtasks /Delete /TN aiusage-serve /F

  消しても start-serve.cmd は残る。手で起動したいときはそれを実行する。

多重起動はしない。start-serve.cmd はポート 3847 が LISTENING なら
何もせずに終わる。2つ目の serve は失敗せず 3848 に退避し、
.serve-port を書き換えてしまう。そうなると hook は新しい方を向き、
古い方も動き続けて、同じDBに対してクォータ取得・通知・Codex カーソルが
二重に走る。エラーにならないので気づきにくい。

注意: 登録は schtasks ではなく PowerShell の Register-ScheduledTask で
行った。schtasks /Create /SC ONLOGON は管理者権限を要求して失敗する。

## Tailscale 経由でスマホから見る

端末:
  desktop-qos4c85   100.82.102.59   Windows 11
  nothing-phone-3a  100.101.3.31    Android 16

手順:

1. パスワードを設定する（未設定なら serve が起動を拒否する）
     aiusage set-dashboard-password
   値は stdin から読むのでシェル履歴に残らない。
   設定済みかどうかは `aiusage dashboard-password-status` で分かる。
   値は表示しない。

2. 両方のアドレスで起動する
     aiusage serve --host 127.0.0.1,100.82.102.59
   127.0.0.1 は書かなくても必ず listen するが、書いておくと意図が読める。

3. スマホのブラウザで http://100.82.102.59:3847 を開き、ログインする
   cookie はホスト単位なので、PC で入れたログインは引き継がれない。
   スマホ側で1回ログインする。

同じ Wi-Fi の他の機器からは見えない。listen しているのは loopback と
Tailscale のアドレスだけで、LAN の IP にはバインドしていない。

Tailscale が落ちているとき:
  100.82.102.59 の listen が EADDRNOTAVAIL で失敗し、warn が1行出る。
  serve は 127.0.0.1 で動き続け、hook も通知も止まらない。
  ただしパスワードは要求されたままになる（要求した時点で公開の意図が
  あったと読むため）。ローカルだけで使う日は --host を外して起動する。

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
