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

### ドキュメントを機械的に書き換えたら、diff の数字を見る

**変更の性質と diff の数字が合っているかを必ず確認すること。
追記のはずなのに削除があれば、そこで止まる。**

DECISIONS.md に1段落足すスクリプトが、D16 の後半から D19 までと
D26 を消した。コミット直後の `git diff --stat` が
「280 変更・179 削除」と出ていて、追記しかしていないのに
削除がある、という食い違いで気づいた。
見出しの数を数えれば1秒で分かる話でもあった（21 → 26 のはずが 22）。

原因は区切りの探し方:

```js
const end = t.indexOf('\n\n', i)   // ← CRLF のファイルでは一致しない
```

**CRLF のファイルを `'\n\n'` で分割してはならない。**
`\r\n\r\n` の中に `\n\n` は現れないので、`indexOf` は
「次の、LF だけの空行」まで飛ぶ。そこまでが丸ごと消える。
このリポジトリの docs は CRLF。

安全な書き方:
- 空行ではなく**次の見出し**を目印にする（`'## D17.'` など）。
  見出しなら改行コードに依存しない。
- どうしても改行で切るなら `/\r?\n\r?\n/` を使う。
- 書き換えた後に、消えてはいけないものが残っているか数える。

```
# 見出しが減っていないか
grep -c "^## D" docs/project/DECISIONS.md

# 元の行が全部残っているか（0 でなければ何か消えている）
git show <before>:docs/project/DECISIONS.md | sed 's/\r$//' | sort -u > /tmp/b
sed 's/\r$//' docs/project/DECISIONS.md | sort -u > /tmp/n
comm -23 /tmp/b /tmp/n | grep -vc '^$'
```

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
新しい端末を足す手順は docs/project/SETUP-NEW-MACHINE.md に分けてある。
schtasks /End が子プロセスの node を残す件もそこに書いた。

## 画面の変更は serve の再起動を待たない

serve は packages/cli/dist/web をリクエストごとにディスクから読む。
したがって web をビルドして copy-web.js が走った時点で、
本番プロセスを再起動していなくても、本番が配る画面が入れ替わる。

実際に 8-B-2 の検証中にこれが起きた。dev サーバと本番 serve が
同じ dist/web を共有しているため、「dev で検証してから本番に適用する」
という手順が web については成立しない。

影響するもの:
  packages/web の変更 → ビルドした時点で本番に反映される
                        （**ブラウザで開いた場合に限る。下記**）
  packages/cli の変更 → **常駐 serve の中のコードだけ**、再起動まで反映されない

### ただしインストール済みアプリ（PWA）には当てはまらない

**「ビルドした時点で反映される」はブラウザのタブの話である。**
インストール済みアプリには Service Worker のキャッシュがあり、
画面のシェル（JS・CSS・index.html）はそこから配られる。

症状はこう出る。

    通常の Chrome タブ      新しい画面が即座に出る
    インストール済みアプリ   古いバンドルのまま

**数字は正しいまま画面だけが古い。** API の応答はキャッシュしていないので
（`/api/` は Service Worker が素通しする）、
**新しい部品を必要とする表示だけが出ない。** 気づきにくい形である。

原因は更新の遅さで、届かないわけではない。アプリを起動すると
その時点で新しい Service Worker の確認が始まるが、
**画面はもう古いバンドルで立ち上がっている。**
したがって新しい画面が出るのは次回の起動時になる。
**常に1回分うしろにいる。**

当面の運用: **画面の変更を本番で確かめるときは、
アプリを一度閉じて開き直すこと。** それでも出ないときだけ
キャッシュを疑う。

（更新方式そのものの見直しは別途。案を出した段階で、まだ入れていない。）
  マイグレーション     → **ビルドした時点で本番に届く。下記を読むこと**

### マイグレーションはビルドした瞬間に本番へ届く

**「serve を再起動するまで適用されない」は誤りだった。** 3回事故が起きて
から気づいた。`dist/index.js` を叩くのは常駐 serve だけではない。

  ・Claude Code のステータスライン（プロンプトのたび）
  ・hook（agent-event、セッション中は数秒おき）
  ・タスクスケジューラ（5分ごとの watchdog）

これらは短命プロセスとして起動し、**そのたびに DB を開いて
runMigrations が走る**。したがって dist にマイグレーションを含めて
ビルドした時点で、次に誰かが index.js を叩いた瞬間——たいてい数秒後——
本番のスキーマが変わる。

過去3回、**すべて経路が違う**:

  v14      プレビューサーバ経由
  v19      `node -e "require('.../dist/index.js')"` 経由（読み取りのつもり）
  v21・v22 ステータスライン経由（自分では何も実行していない）

3回とも「調査で CLI のエントリを実行しない」という教訓では防げていない。
3回目は**エントリを叩いてすらいない**。ビルドしただけで届いた。

**したがって、承認されていないマイグレーションを dist に入れないこと。**
検証は dist を経由せず、src から直接行う:

```
npx tsx -e "import Database from 'better-sqlite3'; import { runMigrations } from './packages/cli/src/db/migrations/index.js'; const db = new Database('.dev-aiusage/cache-copy.db'); runMigrations(db); db.close()"
```

複製に対して走らせること。`AIUSAGE_HOME` を指定しても、
**DBのパスを明示的に渡さなければ守りにならない**
（runMigrations は渡された接続に対して走る）。

したがって web の変更は、隔離検証の対象外だと理解して扱うこと。
本番に出したくない画面変更があるなら、ビルドしないこと。
逆に、画面を戻したいときは revert して再ビルドすれば、
serve を止めずに戻せる。

※ 本当に隔離したいなら packages/web の vite dev サーバを
  別ポートで動かす形になる。現状そうなっていないことを認識した上で
  作業すること。

### tsup 単体で走らせると本番の画面が消える

`packages/cli` のビルドは `tsup && node scripts/copy-web.js` の2段で、
tsup は dist を消してから作り直す。**`npx tsup` だけを走らせると
dist/web が消え、本番 serve は再起動していなくても
`/` に 404「Web dashboard not found」を返すようになる。**

実際に Web Push の実装中にこれをやった。本番プロセスは生きたまま、
画面だけが落ちた。復旧は copy-web.js を走らせるだけ:

```
node packages/cli/scripts/copy-web.js
```

CLI をビルドするときは `pnpm --filter ... build` か、
最低でも tsup の直後に copy-web.js を走らせること。
tsup 単体で終わらせないこと。


### `source_file NOT LIKE 'synced/%'` で「他機由来」は絞れない

古いコードはこの条件を「他の端末から来た行」の代用に使っている。
**もう代用にならない。** 同期でも直送でも、レコードは送信元の実
source_file を持ったまま届く。`synced/<deviceId>` になるのは
source_file が空だった行だけ。

実測: ノートPCから届いた codex 72行はすべて実パスを持っており、
この条件では1行も除外されなかった。

自機の行だけを選びたいときは `device_instance_id` を使うこと。
ただし自機の id が `'unknown'` のことがある（D1）ので、
その場合は `source_file NOT LIKE 'synced/%'` を**併用**する
（置き換えではなく AND）。
platform の埋め戻しで実際にこの順序で間違えかけた。

### バックアップの検証は複製に対して行う

ロールバックできるか確かめようとして backup の cache.db を
read-write で開き、**WAL がチェックポイントされて -wal と -shm が消えた**。
中身は無事だった（`PRAGMA integrity_check` = ok）が、
復旧手段そのものを書き換える操作だった。

**読むだけのつもりでも SQLite は開いた時点で書く。**
`cp` してから開くこと。`readonly: true` でも -shm を触るので、
バックアップ本体には使わない。

### AIUSAGE_HOME を設定せずに DB のパスだけ差し替えない

`watermark.json` は DB の外にあり、`AIUSAGE_DIR`（＝ AIUSAGE_HOME）から
解決される。DB だけ複製に向けても watermark は本番のものが使われる。
複製に対するパースが本番の watermark を書き換える。

**隔離は AIUSAGE_HOME で行うこと。DBパスの差し替えは隔離ではない。**

あわせて watermark.json 自体の性質:

  ・`WatermarkManager.load()` は **JSON の解析に失敗すると
    黙って全ツール分を空にして返す**（watermark.ts の catch）。
    その状態でパースすると全ログを先頭から読み直し、
    `insertRecord` が INSERT OR REPLACE なので既存行が
    **そのときのパーサの値で上書きされる**。
  ・複数プロセスが同時に書く（serve とステータスラインなど）と、
    片方が読んだ瞬間に他方が書いていれば解析に失敗しうる。

実際に codex 449行が 14:53 に全件再挿入された
（ingested_at が2秒幅に集中）。watermark が空になった以外に
説明の付く経路が見つからなかった。

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

実機で到達を確認済み（2026-08-30）。未認証のとき、
`/` は 200 で返り、`/api/summary` `/api/quotas` `/api/agent/sessions`
`/api/cost` はいずれも 401 になる。画面の枠だけ出てデータが出ないのは
この状態。ログインすれば埋まる。

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

## 狭い画面のレイアウト

判定は思い込みではなく実測で行う。dev サーバ（4847）に対して
viewport を 360x800 / 412x900 にし、ページごとに次を測る。

  documentElement.scrollWidth - clientWidth   … body の横スクロール量
  viewport 右端を超える要素のうち、overflow-x が auto/scroll の祖先を
  持たないもの                                … 横に引っぱっている犯人
  高さ 44px 未満の操作部品                    … タップ領域

SPA なので、`<a href>` を作って click() すればページを再読み込みせずに
全ルートを1回の評価で回れる。ルートごとに navigate すると16回の再読込に
なり、その間にデータが変わって前後比較が濁る。

守る条件:

- body そのものは横に動かさない。広い内容は自分の容器の中で動かす。
- 列は隠さない。狭いから消す、はデータが無いのと同じ。
- `.card` は角丸のために `overflow: hidden` を持つ。表を直下に置くと
  はみ出した列が切り落とされ、スクロールもできなくなる。
  表は `.table-scroll` で包む。card 側は触らない。
- タップ領域の拡大は `@media (pointer: coarse)` の中だけで行う。
  幅で分岐させると、狭くしたデスクトップのウィンドウまで変わる。
- 本文中に並ぶリンクやボタン（/notifications の行ごとの「本文を表示」など）は
  44px にしない。一覧が縦に間延びして読めなくなる方が害が大きい。

デスクトップの退行確認は目視ではなく数値で行う。
変更を `git stash` して再ビルドし、同じ probe を 1280px で流して
主要要素の矩形を突き合わせる。データ量で変わる箇所があるので、
行数も一緒に記録しておくとレイアウト差と区別できる。
実際にこれで1件見つかった: /overview の `.tc-name` に
`white-space: nowrap` を足したところ、デスクトップで2行だった行が
1行になり card が 15px 縮んだ。`min-width: 0` だけに戻して解決した。

dev サーバは `aiusage serve` で、ビルド済みの `packages/cli/dist/web` を
配る。ソースを直しただけでは反映されない。
`pnpm --filter @aiusage/web build` の後に
`node packages/cli/scripts/copy-web.js` を実行し、dev サーバを再起動する。
（フィルタ名は `@aiusage/web`。npm 公開名 `@juliantanx/aiusage-web` を
 指定しても pnpm は「一致なし」で終了コード0を返すので、
 `&&` で繋いだ後続コマンドが走ってしまい、直したつもりで直っていない）

### テーマを足したら、モバイル全ルートを測り直すこと

**テーマ追加の完了条件に「全ルート × 360/412px で横スクロール0」を
必ず入れること。** デスクトップで見て問題が無くても足りない。

ターミナルテーマでこれを怠り、/tokens と /cost が
モバイルで画面の左1/4に潰れた状態で本番に出た。
原因はテーマ自体の色や罫線ではなく、`.card` の
`overflow: hidden` を `visible` に変えたこと。

  ・チャートの罫線は `right: -9999px` で描かれていて、
    カードの clip に切られることを前提にしていた
    → clip を外した瞬間、360px の画面で scrollWidth が 10,093px になった
  ・`overflow: hidden` はカードをスクロールコンテナにしていた。
    grid item のスクロールコンテナは自動最小サイズが0になる。
    `clip` はスクロールコンテナではないので、/overview のカードが
    表の min-content 幅まで広がり、96px はみ出した

どちらも「テーマの見た目」ではなく、
**overflow の値が担っていた副作用**が消えたことによる。
色を変えるだけのつもりでも、レイアウトに効くプロパティを
1つでも触ったら全ルートを測ること。

測り方は上の節と同じ。SPA なので、a要素を作って click すれば
リロードせずに全ルートを回せる。テーマは data-theme 属性の
差し替えだけで切り替わるので、1回の実行で
全ルート × 全テーマを測れる。


## Claude のトークンを切らさない

デスクトップアプリを使っている限り、CLI の
`~/.claude/.credentials.json` は更新されない。accessToken の寿命は8時間なので、
放っておくと毎日必ず失効し、aiusage の Claude クォータが止まる。
理由と実測値は D20。

  タスク名   : aiusage-claude-token-refresh
  間隔       : 10分ごと ＋ ログオン時
  実体       : ~/.aiusage/claude-token-refresh.cjs
  起動        : ~/.aiusage/run-token-refresh.vbs（ウィンドウを出さないため）
  ログ       : ~/.aiusage/claude-token-refresh.log

スクリプトは expiresAt を読むだけで、残りが15分を超えていれば
何もせず 90ms 程度で終わる。ログにも書かない。
残り15分を切ったときだけ `claude doctor` を起動する。
更新するのは CLI 自身であり、aiusage は認証ファイルに書き込まない。

削除するには:

    Unregister-ScheduledTask -TaskName aiusage-claude-token-refresh -Confirm:$false

止めると8時間ごとに失効する。失効したこと自体は Discord に1通通知が飛ぶので
（後述）、通知が来たらこのタスクが動いていないと考えてよい。

### 更新ロックの残留

更新は `~/.claude/.oauth_refresh.lock`（mkdir 方式のロック）で直列化される。
短時間に連続して更新を起こすとロックが残り、約90秒のあいだ
`claude doctor` も `claude mcp list` も黙って更新しなくなる。
放っておけば CLI 側が期限切れとみなして解放する。
ログの「expiry did not move」はこれで、失敗ではない。次の10分で再試行される。
手で連打しないこと。スクリプト側にも5分の間隔ガードを入れてある。

### 認証ファイルを触るときは事前に承認を取る

`.credentials.json` の値そのものを触らない書き換え（expiresAt だけを
過去にする等）であっても、他ツールの認証ファイルの改変は事前に承認を取ること。
またバックアップからの復元をしてはいけない。refreshToken はローテーションするので、
古いファイルを書き戻すと無効な refreshToken に戻り、ログアウトさせてしまう。
壊した場合は CLI 自身に書き直させること（expiresAt を過去にして `claude doctor`）。

## serve は自分で復帰する

aiusage-serve タスクは、ログオン時に加えて10分ごとに実行される。
start-serve.cmd は 3847 が LISTENING なら何もせずに終わるので、
繰り返し実行そのものが watchdog になっている。監視の仕組みは足していない。

  実測: 20:19:57 に serve を kill → 20:21:01 にタスクが起動
        → 20:21:04 に listen 再開。停止時間 67秒。

落ちたことを通知で知らせることはできない。落ちているのだから送れない。
だから監視ではなく自動復帰にしてある。

ログは起動した回だけ書く。10分ごとに「既に動いている」と書くと、
意味のある行が埋まる。

前回が異常終了だった場合は1行残る:

    aiusage: previous serve left .serve-port behind - it was killed, not stopped

serve は graceful shutdown で `.serve-port` を消す。残っていれば
kill されたということで、それがこの死に方の唯一の痕跡になる。

### コンソールを作らない起動はできなかった

2026-08-30 に serve が STATUS_CONTROL_C_EXIT (0xC000013A) で終了し、
14分間停止していた。タスクは `cmd.exe /c start-serve.cmd` を
InteractiveToken で実行するので、そのコンソールに Ctrl+C 相当が届けば
serve ごと死ぬ。根本的にはコンソールを持たない実行にしたい。

「ユーザーがログオンしているかどうかにかかわらず実行する」(S4U) が
その方法だが、このアカウントでは登録に管理者権限が要る:

    Register-ScheduledTask -LogonType S4U  →  Access is denied.

したがって10分間隔の繰り返しで吸収する方を採った。
昇格できる状況になったら S4U に変えるのが根本に近い。

### 実行中のバッチファイルを書き換えないこと

cmd.exe は .cmd をバイト位置で読み進める。実行中に中身を差し替えると、
次の行を読むときに新しいファイルの同じバイト位置から再開する。
start-serve.cmd を差し替えた直後にこれが起き、node が終了した時点で
cmd が「起動」の行に戻って serve をもう一度立ち上げた。
watchdog が効いたように見えて、実際は編集の副作用だった。
書き換えたら、走っている cmd.exe を終わらせてからタスクに任せること。

## スマホに通知を出す（Web Push）

Discord を職場であまり見ないので、スマホの通知そのものを使う。
Discord は止めていない。両方に同じ内容が届く。

### 一度だけやること

```
node packages/cli/dist/index.js generate-vapid-keys
```

秘密鍵は `~/.aiusage/config.json` の `credentials.vapidPrivateKey` に入る。
webhook と同じで、API のレスポンスにもログにも出ない。
公開鍵は `vapid.publicKey` に入り、ブラウザが購読するのに要るので API が返す。

**2回目以降は `--force` なしでは上書きしない。**
鍵を替えると既存の購読が全部届かなくなるのに、
ブラウザ側は購読が生きているように見えたままになる。

### 端末ごとにやること

設定 →「ブラウザ通知」→「この端末で有効にする」。
**通知の許可を求めるのはこのボタンを押したときだけ**で、
ページを開いただけでは求めない。一度拒否されるとサイト側からは
やり直せないので、勝手に出さないこと。

iPhone / iPad は、いったんホーム画面に追加してそこから開かないと
購読できない。設定画面にもそう出る。

### 送信先の切り替え

設定 → 通知 → 送信先。Discord は既定で有効、ブラウザ通知は
明示的に有効にしたときだけ送る。片方だけ変えても、もう片方は変わらない。

### 届かないとき

- `/api/push/status` の `configured` が false → 鍵がまだ無い
- `enabled` が false → 送信先でブラウザ通知が切れている
- `subscriptions` が空 → どの端末も購読していない
- 端末一覧に「N回続けて失敗しています」→ その端末だけ届いていない

404 と 410 が返ったときだけ購読を消す。これは配信サービスが
「その登録はもう無い」と言っている場合で、それ以外の失敗
（500 など）では消さない。消すと、動いている端末を黙って
解除してしまう。

### 確かめていないこと

RFC 8291 §5 の試験ベクタと一致することは確認済み。
FCM に実際に届く（VAPID の署名が受理される）ことは、
**実機で購読してからでないと確かめられない**。
FCM は登録 ID を先に見るので、偽の endpoint への 404 は
署名が通ったことの証拠にならない。


## 資格情報が失効したら1通だけ通知する

クォータ取得が認証エラーで失敗したとき、Discord に1通送る。
更新タスクが効いていれば普通は届かないので、
**この通知が来ること自体が「更新タスクが動いていない」の合図**になる。

  イベント種別 : quota_credential
  条件         : classifyQuotaError が 'auth' を返したとき
                 （= 資格情報が expired）
  送らない場合 : not_found。そのツールを使っていないだけであり、
                 壊れているのとは違う（D15 と同じ原則）

繰り返さない仕組み: dedupe_key に「そのツールが最後に取得できた時刻」を
入れている。

    quotaauth:<tool>:<last_success_at>

`last_success_at` は失敗では動かない（markFailure が触らない）ので、
5分ごとに96回失敗してもキーは同じで、notifications の dedupe_key の
UNIQUE 制約が2通目以降を捨てる。復旧して取得が成功した瞬間に値が動くので、
次に失効したときは別のキーになり、改めて1通届く。

文言には復旧方法を入れてある。claude-code なら
「claude を起動するか claude doctor を実行すると更新されます」。
回復手段の書いていない警告は、受け取った側には故障の報告でしかない。

## 検証で他のプロセスを巻き込まない

本番 serve が強制終了された事例が3件ある。うち3件目は、ユーザーが
スマホで画面を見ている最中に起き、「API error」が出た。実害である。

原因は特定できていない（下記）。特定できるまでの運用として:

- プロセスを止めるときは、**対象を1つに絞ってから**実行する。
  コマンドラインで絞り込むときは、開発サーバと本番の両方に
  一致しないことを確認する。実際に一度、本番を止めるつもりで
  開発サーバも一緒に落としている
  （`serve --port 4847` は `serve` に一致する）。
- graceful shutdown の検証（Ctrl+C 相当）は、
  **本番と同じコンソールに他の serve がいないことを確認してから**行う。
  Windows の GenerateConsoleCtrlEvent はプロセス単位ではなく
  コンソールグループ単位で届くため、対象だけを狙うことができない。
  隔離環境（AIUSAGE_HOME=.dev-aiusage）の serve に対してのみ行うこと。
- タスクスケジューラのトリガを PowerShell で作るときは
  `Repetition.StopAtDurationEnd` を確認すること。
  `New-ScheduledTaskTrigger -RepetitionInterval` は既定で true を入れる。
  これは「繰り返し期間の終わりに実行中のタスクを止める」設定で、
  常駐させたいタスクに付けてよいものではない。
  実際に aiusage-serve と aiusage-claude-token-refresh の両方に
  入っていた（現在は両方 false）。

## serve が落ちてから戻るまで

  watchdog の間隔      5分（10分から短縮）
  listen までの時間    ポートを先に開けてから起動時パースを行う

起動時パースは better-sqlite3 で同期実行のため、22,000件で数十秒
イベントループを止める。以前はこれが `server.listen()` より前に走り、
その間の接続は ECONNREFUSED で拒否されていた。
現在は listen を先に済ませるので、パース中の要求は accept キューで待つ。
**半端なデータが返ることはない**: パースがループを止めている以上、
要求はパースの前か後にしか処理されないため。

起動時に前回からの空白が1行出る。

    [serve] 前回の稼働確認から約N分ぶりの再開です（前回は正常停止していません）

serve は稼働中 `.serve-port` の mtime を1分ごとに更新する。
強制終了されたプロセスは停止時刻を書き残せないので、
「最後に生きていた時刻」があらかじめディスクに無いと空白が測れない。
正常停止では `.serve-port` を消すので、この行は出ない。

## つながらないときの画面

すべての失敗が「API error」と表示されていたのをやめた。

  接続できない  「サーバに接続できません。PC の aiusage が起動していないか、
                Tailscale が切れている可能性があります。」
                加えて 0.5秒・1秒・2秒 の間隔で3回だけ自動再試行する
  5xx           「サーバがエラーを返しました。」
  401           既存の認証経路（ログイン画面に戻る）
  それ以外      サーバのメッセージをそのまま出す

再試行を3.5秒で打ち切るのは、それ以上待っても意味が無いため。
本当に落ちている場合の復帰は watchdog の次のティック（最大5分）であり、
どんな再試行間隔でも届かない。長く待たせるのは、
同じ答えを遅く出すだけになる。

## パースが止まったことに気づく

定期パースが動いていないのに serve は起動している、という状態が
38分続いたことがある。ログには何も出ていなかった。原因は
「パースのタイマーが存在しなかった」ことだが、
**気づけなかった理由はログの読み方の側にある。**

### ログには出来事を、`/api/health` には状態を

定期パースのログは、取り込むものがあったときだけ1行出す。

    [serve] parsed 12 records, 3 tool calls (scheduled).

5分ごとに「0件でした」を出すと、意味のある行がその中に埋もれる。
起動時のパースとは `(scheduled)` で区別できる。

ただしこの方式には、それ単体では埋められない穴がある。
**「パースして0件だった」と「パースしていない」が、
ログの上では同じ沈黙になる。** 前者は正常、後者は障害である。

だから状態は `/api/health` が答える。

    parse.lastParseOkAt   最後にパースが完走した時刻（失敗・未実行では動かない）
    parse.intervalMs      いま有効な間隔（設定変更に追従する）
    parse.thresholdMs     停止とみなすまでの時間（間隔の3倍）
    parse.stalled         判定
    parse.stalledSince    停止が始まった時刻

**ログの沈黙が状態を知る唯一の手段である状況を作らない。**
ログは端末を見ている間しか読めないが、状態はいつでも訊ける。

### 判定は1箇所、出力は2つ

判定は `RuntimeSettingsController.parseHealth()` だけが行う。
通知も画面の帯も、そこが出した答えをそのまま繰り返す。
2箇所で計算すると、通知は「異常」で画面は「正常」という食い違いが起きうる。

閾値は `間隔 × 3`。**間隔は判定のたびに config から読む。**
config は serve の実行中に再読み込みされうるので、
起動時のスナップショットで判定すると、間隔を変えた瞬間から誤報になる
（遅くしたら鳴りっぱなし、速くしたら何時間も黙る）。

検知のタイマーはパースのタイマーとは別に持ち、`applyConfig` の外で作る。
**見張りが見張る対象と運命を共にしていては、
対象が止まったことを報告できない。** `applyConfig` は他のタイマーを
全て破棄して作り直すので、そこに置くと config の再読み込みで
検知器だけが静かに消える。

`lastParseOkAt` を更新するのは **パースが例外を投げずに完走したときだけ**。
投げた実行や、前の実行が終わらず早期リターンした実行は、
データの鮮度という点では「実行しなかった」のと同じである。

### spoke では通知はどこにも届かない

通知の宛先（webhook・VAPID の購読）はハブにしか無い。
**ノートPCでパースが止まっても、通知はどこにも届かない。**
`notifyParseStalled` は行を積むが、誰も配送しない。

これは今回の実装の欠陥ではなく **構成上の限界** である。
誰も見ていない機械が、自力で誰かに知らせることはできない。
spoke については、当面は次のどちらかで確認する。

    curl http://<spoke>.<tailnet>.ts.net:PORT/api/health
    spoke の画面を開く（帯が出る）

ハブが「黙った spoke」に気づく仕組みは、まだ無い。

### 画面の数字を報告するときは、読み込みから3秒おく

ホームの主要数字（合計トークン・合計コスト・セッション数・利用日数）は、
以前トゥイーンで0から上がっていた。**読み込み直後の画面は
実際より小さい値を写す。** 隣の内訳はアニメーションしないので、
合計だけが小さく、内訳は正しい、という画面ができる。

2回、調査を発生させている（−40,816,028 と −171,188,798。
どちらも DB は減っていなかった）。

数値のアニメーションは廃止した（表示値は常に取得値）。
それでも**スクリーンショットで数字を報告するときは3秒おくこと。**
描画の途中を撮らないのは、この1件に限った話ではない。

## マイグレーションを適用してよいのは serve だけ

短命の CLI 呼び出しがスキーマを更新するのをやめた。

    createDatabase        作る・マイグレーションを適用する。**serve のみ**
    openWithoutMigrating  読むだけ。無ければ作らない。古ければ拒否する

### 何が起きるか

    DB が無い          「No database at <path>.」
                       「Start `aiusage serve` to create one.」  終了コード 1
                       **ファイルは作らない**

    スキーマが古い     「This database is at schema v20; this build expects v22.」
                       「Start `aiusage serve` to bring it up to date.」  終了コード 1
                       **適用しない**

    スキーマが新しい   警告を出して続行。
                       このビルドが読む列は全部あるので、前に進む分には壊れない

    素の `aiusage`     「aiusage: database not ready — run: aiusage serve」
                       1行だけ出して **終了コード 0**。
                       ステータスラインが数秒ごとに呼ぶので、
                       対処できない助言を並べても仕方がない

古いスキーマを「拒否」で、新しいスキーマを「警告して続行」で扱うのは
非対称だが理由がある。**新しいコードが古いDBを読むと、
列が無くて落ちるか、黙って 0 を返す。** 後者がいちばん気づきにくい。
今日の breakdown_missing の行がまさにその形だった。

### DB ファイルを自動生成しないこと

`createDatabase` は mkdir までしていた。どのコマンドでも本番パスに
DB が生えるので、**間違った場所を開いたことに気づく最初の手がかり
（ファイルが無い）が、黙って潰されていた。**

### ★ これで塞がるのは4件中1件だけ

今日の事故4件のうち、この変更が防ぐのは1件である。
**塞いだつもりにしないこと。**

    v21/v22  ステータスラインが `aiusage` を呼び、dist が本番へ適用
             → **塞がる。** 素の `aiusage` はもうマイグレーションしない

    v19      `node -e "require('.../dist/index.js')"` から
             runMigrations を直接呼んだ
             → **塞がらない。** エクスポートを直接呼ぶ経路には
               コマンドの区別が無い。ログは出る（v19 の後に追加済み）

    v14      プレビューサーバ経由
             → **塞がらない。** プレビューサーバも serve であり、
               serve は適用してよい側である。
               「serve だけ」は「意図した serve だけ」ではない

    watermark  テストが本番のファイルを削除
             → **無関係。** マイグレーションの話ではない。
               tests/setup.ts の AIUSAGE_HOME 固定で別途対処済み

### 実際に働いた（2026-09-01、仕込んでいない場面で）

v24 を作ってビルドした直後、**dist は v24 を期待し本番DBは v23**
という状態が数分できた。そこで素の `aiusage` を実行すると:

    aiusage: database not ready — run: aiusage serve
    (exit 0)

**黙って本番に当てず、serve を案内して終了した。**
これは v21/v22 の事故そのものの形であり、
仕込んだ試験ではなく通常の作業の途中で起きた。

**「エントリを実行しない」という v14 の教訓は、v21/v22 を防げなかった。**
経路ごとに教訓を足しても、次の経路は塞がらない。
今回もその1つであって、最後の1つではない。

v19 型と v14 型に効くのは、コマンドの区別ではなく
**「本番の AIUSAGE_DIR に対して、意図せず書き込みうる実行を止める」**
側の対策になる。まだ無い。

## 黙った spoke に気づく（段階1・2のみ。通知はまだ無い）

ハブが持っていたのは「最後にレコードを受け取った時刻」だけで、これでは

    spoke が壊れて送れていない
    spoke は元気だが送るものが無い

が**同じ沈黙**に見えた。パース停止で解いたのと同じ形が1階層上に出ている。
解き方も同じで、**沈黙に意味を読ませるのではなく、沈黙をやめさせる。**

spoke はパースのたびに、0件でも `POST /api/sync/heartbeat` を送る。

    「送ってこない」  heartbeat が来ていない        → 異常
    「送るものが無い」 heartbeat は来ていて 0件      → 正常

**判定に使うのは heartbeat の時刻であって、レコードの時刻ではない。**

`/api/health` の `spokes` に、端末ごとに出る。

    lastHeartbeatAt  最後に届いた時刻（**ハブが押す**。
                     spoke の時計が狂っていても自分を新鮮と主張できない）
    lastRecordsSent  そのとき送った件数（0 が正常でありうる）
    lastParseOkAt    spoke 自身のパース検知が最後に見た時刻
    thresholdHours   その端末の沈黙許容時間
    silent / silentSince

### heartbeat はパースから駆動する

別タイマーにしない。**「パースは止まっているが heartbeat は元気」**
という、ハブの判定を無いより悪くする組み合わせが作れてしまう。
パースに乗せておけば、保証している対象が止まったときに heartbeat も止まる。

送信は `runHubUpload` の中の、**`nothing_to_send` の早期 return より前**。
そこが「元気だが送るものが無い」の分岐そのもので、
週末ずっと止まっている spoke は5分ごとにここを通る。
records と一緒にしか送らないと、**いちばん静かな端末が
いちばん生存報告をしない**ことになる。

### 閾値は端末ごと（config）

    "hubSilenceHours": { "<deviceInstanceId>": 24 }

未設定は既定の **168時間（1週間）**。緩いのは意図的である。

**この3台が「正常に黙っている時間」を、まだ誰も測っていない。**
職場PCが夜間・週末にどれだけ黙るのか、ノートPCが何日開かれないのか、
実測が無い。この状態で数字を決めるのは、
単価の分からないモデルに価格を推測で入れるのと同じである。

`/api/health` を1〜2週間眺めて分布を見てから決める。
**それまで通知は入れない**（判定は出るが、誰にも届かないので実害が無い）。

### ★ これで塞がらないもの

  ・**ハブ自身が止まったら誰も気づかない。**
    同じ方法では解けず、外から見る何かが要る。範囲外である

  ・**送信経路だけ壊れた spoke は「止まった」と出る。**
    区別できない。ただしどちらも対処が必要なので実害は無い

  ・**新しい spoke は、閾値を設定するまで既定値で判定される**

  ・heartbeat を送らない古い spoke は `spokes` に**現れない**。
    「不明」であって「異常」ではない。
    現れないことを異常とすると、版の違いを障害に仕立ててしまう

## pnpm add が EACCES で落ちる（ストアのリンク切れ）

    EACCES: permission denied, open
      '...\.pnpm\esbuild@0.21.5\node_modules\@esbuild\linux-x64\package.json'

**Windows に入らない Linux 用バイナリを指したシンボリックリンクが
壊れたまま残っている。** pnpm がそれを辿って落ちる。
パッケージ名は実行のたびに変わる（esbuild / rollup の linux-x64、
linux-x64-musl など）ので、権限の問題に見えるが違う。

リンク切れだけ消せば通る。

    for D in node_modules/.pnpm/esbuild@*/node_modules/@esbuild \
             node_modules/.pnpm/rollup@*/node_modules/@rollup; do
      for L in "$D"/*; do
        [ -L "$L" ] && [ ! -e "$L" ] && rm "$L"
      done
    done

消すのはリンク切れのみで、実体のあるものは触らない。
`pnpm install` でいつでも復元される。

## どの端末がどの版で動いているか

3台を手で更新しているので、実際に困るのは
**どれを更新したか忘れること**。覚えているより訊いたほうが速い。
spoke は5分ごとに heartbeat を送っているので、そこに載せる。

`/api/health`:

    "hub": { "commit": "2749318", "commitTime": 1756... },
    "spokes": [
      { "device": "職場PC", "commit": "d8ddd58", "commitTime": 1756..., "behind": true }
    ]

**ハブの版はトップレベルに1つ。各行には判定の結果を置く。**
`behind` は `hubHealth` が決める。読む側に
「commitTime を比べる」をやらせない ―― 同じ2つの版を見て
2箇所が違う答えを出す状態を作らないため。

`commit` と `commitTime` の両方を持つのは、片方では答えられないから。
ハッシュは「同じ版か」を言えるが「どちらが古いか」を言えない。
時刻は順序を付けられるが、同じ秒の2つを区別できない。

`behind` が `null` になるのは、どちらかが版を言えないとき
（版を送らない古い spoke、git 無しでビルドされた側、
ソースから直接動かしているハブ）。
**不明を「古い」にしない。** 欠けている値を判定に変えることになる。

### この比較が意味を持たない場合

**別ブランチにいる spoke。** `commitTime` の比較は
3台とも `main` を追っている前提でしか成り立たない。
別ブランチの端末は、`main` より新しいコミットの上にいても
`behind: true` と出ることがあるし、その逆もある。
今は3台とも `main` なので運用できているだけで、
枝を切ったらこの列は読めなくなる。

**ビルドせず `git pull` だけした端末。**
版はビルド時に焼き込まれるので、pull しただけの端末は
古い版を報告し続ける。**これは正しい** ―― 訊いているのは
「何が動いているか」であって「何がチェックアウトされているか」
ではない。ただし「pull したのに古いままだ」と見える場面があり、
そのときは `aiusage-update.cmd` を通していないだけ。

## 更新スクリプトを実地で通して出たこと（2026-09-01、ハブ7回）

**7回かかった。5つとも、読んでいる限り見つからなかった。**
「机上でないこと」を条件にしていなければ、全部残っていた。

### 1回目 ─ CLI をビルドせずに「成功」した

    pnpm --filter @aiusage/cli build
    → No projects matched the filters "@aiusage/cli"

**CLI のパッケージ名はディレクトリ名と違う**（`@juliantanx/aiusage`）。
そして**マッチしない `--filter` は pnpm にとってエラーではない。**
1行出して exit 0 で終わる。結果:

  ・画面（web）だけビルドされた
  ・CLI は素通り。dist は古いまま
  ・serve は古いコードで再起動した
  ・スクリプトは**成功として終了した**

いちばん危ない形。「更新した」と思って別の端末に進む。
今は `packages/*/package.json` の `name` を**生成時に読む**。
打ち間違える機会を無くした。

### 1回目 ─ 失敗した install を素通りした

`pnpm install --frozen-lockfile` が EACCES で落ちたのに、
`if errorlevel 1` が真にならず先へ進んだ。

**`if errorlevel 1` は「1以上」の意味で、負の終了コードを通す。**
`if not "%ERRORLEVEL%"=="0"` に変えた。

EACCES 自体は既知のストアのリンク切れ（別項）。
sharp@0.34.5 の linux-x64 系4本。消して通した。

### 1・2回目 ─ 再起動がウォッチドッグ任せだった

`schtasks /Run` は**タスクがまだ Running のとき拒否される。**
node の子を落とした直後がまさにその状態で、`/Run` は失敗し、
serve が戻ったのは**5分ごとのウォッチドッグのおかげ**だった。

設計ではなく運。`/End` してから状態が Running を抜けるのを待ち、
それから `/Run` する。

### 2回目 ─ 「戻った」の判定が死体を数えていた

「3秒で listening に戻った」と出たが、新しい serve が起動したのは
その6秒後。**落としたプロセスの listening ソケットが少し残る。**

止める側で**ポートが実際に空くまで待ってから**返すようにした。
これで後段の「listening になった」が意味を持つ。

### 3・4回目 ─ 成功しているのにエラーを出していた

    エラー: スケジュール タスク "aiusage-serve" の実行に失敗しました。

再起動は成功しているのに毎回これが出た。`schtasks` は
状態の切り替わり中にこう言う。**成功時に出るエラー行は、
読み飛ばす習慣を作る**（s3 の11件と同じ話）。

再起動を `aiusage-restart-serve.ps1` に分けた。
`schtasks` の出力は**捨てずに保持し、ポートが戻らなかったときだけ出す。**
そのときは最初に読みたいものになる。

### 5回目 ─ 通った

    Already up to date at fe4aded.
    ...
    packages/cli build: Web build copied to dist/web
    stopping serve (pid 35888)
    aiusage-update: serve is listening on 3847 again after 3 seconds
    aiusage serve listening on http://127.0.0.1:3847

余計な行は無い。

### `Updating:` の検証は、まだ本物の pull で出ていない

前回「両方の分岐を実行して確認」と報告したが、**確認の中身を
そのまま書いておく。**

    Updating: d8ddd58 -> fe4aded   (15 commits)

これは、生成された `aiusage-update.cmd` から該当7行を**そのまま
抜き出し**（バイト単位で一致することを `diff` で確認）、
`AIUSAGE_WAS` / `AIUSAGE_NOW` に実在のコミットを入れて実行したもの。
`(15 commits)` も実際の `git rev-list --count` の結果。

**通っていないのは pull そのもの。** ハブは push する側なので
origin に自分の持っていないコミットが存在せず、この分岐に入れない。
`git reset --hard` で1つ戻す案は環境の権限判定に止められた。

初めて本物として出るのは、**別の端末が1コミット遅れている状態で
`aiusage-update.cmd` を走らせたとき**。

### cmd の `>` は、確かめるつもりだった出力を黙ってファイルにする

上の検証にたどり着く前に、同じ表示を手書きの試験用 `.cmd` で
確かめようとして、`-^^>` と書いた。cmd は `^^` を `^` にしてから
残った `>` を**リダイレクトとして読む。**

  ・画面には何も出ない（出力はファイルへ行った）
  ・カレントディレクトリに `52501c8` という名前のファイルができた
    ─ リダイレクト先の名前が、比較しようとしていたコミットの
      ハッシュそのものだったため
  ・中身は `Updating: d8ddd58 -^   (9 commits)`

**「何も出ない」を「失敗した、次を試そう」と読んで先へ進んだ。**
実際には失敗の証拠がファイルとして残っており、
`git add -A` がそれを拾い、コミット 1dbd8fa として origin/main に届いた。

出力が空になったときは、**それが「出なかった」なのか
「どこかへ行った」なのかを分けること。** cmd では後者がある。

なお**出荷しているほうの7行は `-^>`**（`^` は1つ）で、
これは正しく矢印を出す。壊れていたのは手書きの試験のほうだけで、
生成物ではない。

### 5つ目 ─ 人の入力を待つ箇所（corepack と、資格情報のダイアログ）

    ! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-9.15.0.tgz
    ? Do you want to continue? [Y/n]

`pnpm` はこの端末では **corepack のシム経由**で動いている
（`%APPDATA%\npm\pnpm.cmd` の中身が `corepack/dist/pnpm.js`）。
`package.json` の `packageManager` が版を固定しているので、
corepack はその版を取りに行く前に確認を求める。

#### 実際の条件（corepack の実装を読んだ）

    if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT === `1`) {
      console.error(`! Corepack is about to download ${input}`);
      if (stdin.isTTY && !process.env.CI) {
        stderr.write(`? Do you want to continue? [Y/n] `);

**訊いてくるのは、変数が `1` で、かつ端末が TTY のときだけ。**
だから:

  ・**人が端末から実行したときだけ訊かれる**（＝答えられる状況）
  ・タスクスケジューラや出力をファイルに落とす実行では TTY が無いので、
    通知を1行出して**そのまま進む。止まらない。**

これは前提の訂正になる。**「人が見ていない端末で止まったまま気づかれない」
という形には、corepack はならない。** 止まるのは人がいるときだけで、
壊れるのは「1コマンドで終わる」という約束のほう。

`COREPACK_ENABLE_DOWNLOAD_PROMPT=0` を .cmd の中で設定した。
corepack を迂回する案は採らなかった。**固定の意味が無くなる**からで、
プロンプト1つと、3台の pnpm が静かにずれる状態を交換することになる。
ダウンロードの通知そのものは出るので、黙って取ってくるわけではない。

#### 本当に「止まったまま」になるのはこちら

`git pull` は保存された資格情報が切れると訊いてくる。
この remote は **https + credential helper が `manager`（GCM 2.9.0）**で、
GCM は**ウィンドウを出す。** ヘッドレスの端末では、
誰も見ないダイアログの前でプロセスが待ち続ける。
**出力も無く、失敗もせず、終わりもしない。**

  ・`GIT_TERMINAL_PROMPT=0` ─ git 自身が端末で訊くのを止める
  ・`git -c credential.interactive=false pull --ff-only` ─
    helper にウィンドウを出させない

失敗して終わるので、`if not "%ERRORLEVEL%"=="0"` が拾い、
**動いている serve には手を付けずに**メッセージを出す:

    aiusage-update: pull failed - nothing was built or stopped.
    If it mentions authentication, the stored credential has expired:
    run "git pull" by hand once, where it can ask.

**確かめていないこと:** 資格情報が切れた状態は作っていないので、
ダイアログが実際に抑止されるかは未確認。
`credential.interactive=false` は GCM の文書にある設定だが、
この 2.9.0 のバイナリからは読み取れなかった（単一ファイルで文字列が出ない）。
確認したのは、**この指定を足しても通常の pull が壊れないこと**だけ。

#### 他に待つ箇所が無いかの確認（条件を先に決めて実行）

対象は生成物3つと生成器1つ。

    A  cmd が待つもの          pause / choice / runas / set /p
    A2 timeout（/nobreak 無し）
    B  PowerShell が待つもの   Read-Host / Get-Credential / Out-GridView /
                               PromptForChoice / ReadKey / Wait-Event /
                               -Confirm（-Confirm:$false は除く）
    C  git が編集器を開くもの  rebase / add / commit / merge / mergetool /
                               --interactive
    D  schtasks /U（/P 無しでパスワードを訊く形）
    E  pnpm / corepack

A〜D は**該当なし**。E は上の2箇所のみ。

**grep で見えないものが2つあった**ことは記録しておく。
corepack のプロンプトは `pnpm` という語の先にあり、
資格情報のダイアログは `git pull` という語の先にある。
**呼んでいる語ではなく、その先が何を持っているかで決まる。**

## ウィジェットのビルドが CLI を止めた（2026-09-02、職場PC）

**serve が落ち、データ収集が止まった。** 原因は
`packages/widget/bin/prepare-native.js`。

    1. @electron/rebuild が**共有の** better-sqlite3 を
       Electron ABI に作り直す（in place）
    2. CLI は同じファイルを Node ABI として読む → 起動不能
    3. 戻す手順 execFileSync('npm', ['run','install']) は
       **Windows で ENOENT**（npm は npm.cmd で、execFileSync は探しに行かない）
    4. 戻らないまま残る

**同じ問題に2つの解があり、片方だけが安全だった。**
`bin/install-native.js`（postinstall）は最初から
「使い捨てのコピーの中で prebuild-install を走らせ、共有物には触らない」
と docstring に書いてある。`prepare-native.js` はその配慮を持っていなかった。

### いま直っていること

`prepare-native.js` を postinstall と同じ方式に変えた。
**共有の better-sqlite3 には一切触らない**（一時ディレクトリに
`package.json` だけ写して prebuild-install を走らせ、`.node` を1つ取り出す）。
`@electron/rebuild` は `pnpm run rebuild:electron` として残してあるので、
**明示的に呼んだときだけ**起きる。

「新鮮さ」の判定も直した。旧実装は
**共有の Node ABI 版と、ウィジェットの Electron ABI 版の mtime を比べていた** ──
別々の成果物で、時刻は上流の tarball が持っていたものにすぎない。
しかも一度 rebuild が走ると共有側が現在時刻になり、**以後は永久に false**
になって毎回作り直す。いまは
`dist/native/built-for.json` に electron のバージョンと platform/arch を書き、
それが一致するかで判定する。

**職場PCで false だった具体的な理由は特定できていない**（その端末の
当時のファイルを見ていない）。上の2つの経路のどちらでも起こりうる。

### 復旧手順（この症状が出たとき）

serve が起動しない・`aiusage summary` が `dlopen` で落ちるとき:

    cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
    npm run install          # PowerShell から。cmd の npm.cmd が要る
    # そのあと serve を再起動

新しい `prepare-native.js` は**起動時にこれを自動で確かめて直す**。
ウィジェットをビルドすれば、壊れていたぶんも戻る。

### 確かめたこと

    ビルド前後で node packages/cli/dist/index.js summary が通ること   ✔
    共有 better-sqlite3 の mtime とサイズが変わらないこと             ✔
    2回目はスキップされること                                        ✔
    --force でも CLI が壊れないこと                                  ✔
    Electron ABI の .node を Node で開くと dlopen で落ちること        ✔（実測）
    prebuild-install --runtime=node が Windows で走ること             ✔（実測）

**受け入れ条件はウィジェットがビルドできることではなく、CLI が起動できること。**

### ついでに分かったこと

`require('better-sqlite3')` は**バイナリを読まない**。
better-sqlite3 は最初の `new Database()` まで `.node` を遅延ロードするので、
require が通っても ABI が合っているとは限らない。
確認には `new D(':memory:').close()` まで要る。

Windows は**実行中のプロセスが読み込んでいる `.node` を上書きできない**（EBUSY）。
ウィジェットを起動したままビルドすると必ずここで止まるので、
「トレイから終了してからビルドしてください」と出るようにした。

## 上流が 429 を返す（2026-09-02、ハブ）

### 事実

    claude-code  最後の成功 35分前  連続失敗 7  種別 api
    last_error: API error (HTTP 429) rate_limit_error
    codex        最後の成功 0分前   連続失敗 0

**ウィジェットの「34分前・更新が止まっています」は正しかった。**
壊れていたのは表示ではなく、上流からの取得のほうである。
codex は同時刻に正常だったので、ネットワークでもハブでもない。

### 構造

    /api/quotas は毎リクエスト queryAllQuotas() を実行する
    updateTray() と buildPayload() が別々に叩く = ウィジェット1台で毎分2回
    2026-09-02 にウィジェットをハブ経由に変え、それを台数分に増やした
    5分ごとに集めて quota_current に入れる仕組みが既にあるのに、
    その隣で毎分叩いている

**集めた結果を持っているのに、表示のたびに取りに行っている。**
読み手が1人（ハブだけ）のうちは目立たなかった。

### 対処（別途指示済み・未着手）

`/api/quotas` は `quota_current` から返す。
上流へ行くのは定期収集と `/api/quotas/refresh` のときだけにする。

### 運用上の注意

**ハブが 429 の間、職場PCの `quotaSnapshotInterval` を 0 に戻さないこと。**
その間、職場PCの収集が唯一動いている実測になる。
ハブが復帰し、`aiusage doctor` で claude-code の連続失敗が 0 に戻ってから
0 にすること。

### 確認の仕方

```bash
aiusage doctor
```

`最後の成功` と `連続失敗` を種別ごとに見る。
片方だけ失敗しているなら上流側、両方なら手前側を疑う。
