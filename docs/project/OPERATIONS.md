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
  packages/cli の変更 → **常駐 serve の中のコードだけ**、再起動まで反映されない
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
