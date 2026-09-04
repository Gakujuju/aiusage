# 現在の状態

最終更新: 2026-08-30（更新のたびに書き換える。追記ではなく置換）

## ロードマップ

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 起動確認 | 完了 |
| 2 | 日本語化 | 完了・main マージ済み |
| 3 | 端末識別 | 完了（device / deviceInstanceId） |
| 4 | Claude Code Hook 取り込み | 完了（8イベント、実データ確認済み） |
| 5 | Codex の状態取得 | 完了・実データ確認済み（rollout ログ追尾・D18） |
| 6-A | クォータ履歴・枯渇予測 | 完了（Claude / Codex で稼働中） |
| 6-B | 状態管理・作業時間計測 | 完了 |
| 7 | Discord 通知統合 | 完了（段階3 実施済み・aiusage 単独） |
| 8-A-1 | クォータ推移・枯渇予測の UI | 完了 |
| 8-A-2 | エージェント状態ボード /agents | 完了 |
| 8-A-3 | 通知の設定と送信履歴 | 完了 |
| 8-B-1 | Tailscale 経由での到達性 | 完了・本番適用済み・実機到達確認済み |
| 8-B-2 | モバイル向けレイアウト | 完了（実機確認待ち） |
| 8 | Android/PWA 化 | 未着手（8-B-3 が残り） |

## 未消化の作業

- Phase 5 のクローズ確認のうち、スクラッチ作業での通知1点
  （実プロジェクトでの動作は 2026-08-30 13:27 のセッションで確認済み）
- Phase 8-B-2 の実機確認（nothing-phone-3a から Tailscale 経由）
  ・/sessions /tokens の表を指で横に送れるか、端の影が送れると分かる合図になっているか
  ・/projects の行が積み上がって全項目見えているか
  ・ハンバーガーとナビ項目が押しやすいか
- 段階3 の24時間観測（2026-08-30 16:2x 実施。以下を次回報告する）
  ・作業完了 / 確認・入力待ち / 処理エラー終了 がすべて aiusage から届くか
  ・reason のログに想定外の抑制が出ていないか
  ・応答プレビューが結論行を拾えているか（外れた例があれば）

ルール:

- 指示を受け取ったら、着手前にここへ1行足す
- 完了したら消す
- 指示役はここを見て、渡したはずの指示が載っていなければ再送する

（指示が1件、話題が移った際に渡らないまま流れた。
  双方が突き合わせられる場所として作った）

## スキーマ

- v13 quota_snapshots / quota_current / quota_windows
- v14 agent_sessions / agent_session_events / agent_session_spans
- v15 notifications / agent_sessions.escalation_level
- v16 v_agent_sessions の寛容な JOIN
- v17 records.session_id のバックフィル（本番適用済み・10,368行を修正）
- v18 quota 3テーブルから device_instance_id = '' の行を削除（D17）
- v19 agent_log_cursors（ログ追尾の byte offset）

## 未解決の課題

1. （解消）Claude のクォータ。2026-08-30 に案A を実施
   （`npm install -g @anthropic-ai/claude-code` → `claude` → `/login`）。
   quota.ts は無改修で動いた。取得できる tier は
   five_hour / seven_day / nimbus_quill の3つ。
   seven_day_opus と seven_day_sonnet は CLAUDE_KNOWN_TIERS に
   含まれているがこのアカウントでは返らない。プランによって返る tier が
   違うため想定内で、コード変更は不要。
   nimbus_quill は CLAUDE_KNOWN_TIERS に無い未知 tier で、
   「未知 tier も拾う」ループが拾っている。窓の長さが引けないため
   paceRatio は常に null、ロールオーバー判定は「5ポイント以上の下落」
   のみで行われる（§nimbus_quill の制約 を参照）。
   statusLine 経由（案C）は Desktop で発火しない・行き止まり（記録として保持）。
2. Codex の「確認待ち」は取得できない。rollout ログに該当するイベント型が
   存在しない（10セッション 55,373行を横断して0件）。
   Codex は「作業中 / 完了」の2状態のみ。
   この端末は sandbox = "elevated" かつ対象プロジェクトが trusted なので
   そもそも承認自体が起きにくいが、それとは別に型が無い。
3. Codex のセッション終了イベントも存在しない。ended_at は DECAY_POLICY の
   24時間タイムアウト任せになる。プロセス監視による即時検出は将来の課題。
4. Gemini のクォータは未対応。Gemini CLI のトークン実績は probeGemini で取得可能。
   Gemini アプリ（Web）は消費率 API が非公開で取得手段なし。
5. ChatGPT Web / Gemini Web の会話利用は対象外（公開 API なし）。
   Claude.ai の Web 利用は Claude Code と 5h/7d 枠を共有するため、
   案A が通れば自動的に数字に含まれる。
6. serve のバインドは 127.0.0.1 が既定になった（D16）。
   非ループバックはパスワード必須で、そのとき /api/summary と /api/quotas
   も保護対象に入る。Phase 8（Android/PWA）で外から見る段になったら、
   `--host` + `AIUSAGE_DASHBOARD_PASSWORD` か、
   ループバックのままトンネルを張るかを選ぶ必要がある。
7. `device_instance_id` が全件 'unknown'。正規化は D1 のとおり単独では行わない。
8. コストは API 従量換算であって請求額ではない（D7）。UI で誤読されない表記が必要。

## コスト

本番の総コストは $3,628.10（10,976 レコード、全件 cost_source='pricing'）。
2026-08-30 に価格表を同期するまで $0 だった。原因は D15 を参照。
数字は作業のたびに増えるので、桁が合っていれば十分。

| tool | model | 件数 | コスト |
|---|---|---|---|
| claude-code | claude-opus-5 | 7,624 | $2,527.60 |
| claude-code | claude-fable-5 | 602 | $624.13 |
| claude-code | claude-sonnet-5 | 2,311 | $277.88 |
| codex | gpt-5.6-sol | 439 | $198.49 |

## 稼働中のもの

- 本番 serve: ポート 3847。127.0.0.1 と 100.82.102.59（Tailscale）に listen。
  ログオン時にタスク aiusage-serve が起動する（~/.aiusage/start-serve.cmd）。
  バインド先は config.host、ログは ~/.aiusage/serve.log。
  ダッシュボードはパスワード必須。
- 開発 serve: ポート 4847 / AIUSAGE_HOME=<repo>/.dev-aiusage。
  クォータ取得と通知は無効（OPERATIONS.md「開発サーバは外部 API を叩かない」）。
- クォータ取得: 5分間隔。Claude と Codex の両方。
  claude-code: five_hour / seven_day / nimbus_quill
  codex: five_hour / weekly_limit
  copilot: 認証情報が無いため not_found（正常）
- Codex ログ追尾: 5秒間隔。~/.codex/sessions 配下の rollout-*.jsonl のうち、
  直近7日分のディレクトリ＋カーソル済みファイルで、mtime が直近30分以内のもの。
- Discord 通知: aiusage 単独（2026-08-30 に既存 PowerShell 通知を除去）。
  設定は /settings の通知セクション、送信履歴は /notifications。
  webhook は画面から編集できない（CLI の notify-test --set-webhook のみ）。
  接頭辞 [aiusage] は当面そのまま（一度に2つ変えないため）。
  Codex のターン完了でも通知が出るようになった。
  tool 別に切るなら config の notifications.tools（例 { "codex": false }）。
- 応答プレビュー: 有効（notifications.includeAssistantMessage = true）。
  取得時点で200文字に切り詰め、改行を畳んで assistant_preview に入れる（D10）。
- hook: `~/.claude/settings.json` に8イベント・8エントリ（aiusage のみ）
  （Stop / StopFailure / Notification / UserPromptSubmit /
    SessionStart / SessionEnd / PermissionRequest / PermissionDenied）

## nimbus_quill の制約

CLAUDE_KNOWN_TIERS に無い未知 tier で、resets_at も返らない。
`windowDurationMs` が null を返すため、以下が効かなくなる。

- detectRollover の規則B（reset 時刻のジャンプ）と規則C（観測ギャップ）が
  無効化され、規則A（5ポイント以上の下落）だけで窓の切り替わりを判断する。
  utilization が 0 のまま動かない限り窓は分裂しない。一方、実際の枠が
  リセットされても下落幅が5ポイント未満なら検出できず、窓が閉じない。
- forecastQuota は elapsedRatio と paceRatio を null にする
  （resets_at が無いので経過割合が定義できない）。枯渇予測は出ない。
- window_id のハッシュは resets_at 部分が 'unknown' になるが、
  opened_at を含むので窓ごとに一意であり、断片化はしない。

通知の tier 名は `tierDisplayName` が日本語に写す。未知 tier は
生の名前のまま出るので、80% に達したら「nimbus_quill 80% 到達」と表示される。

## 既知の事象

2026-08-30 11:19 開始の codex セッション1件は、
ウォッチャの初期不具合により device="DESKTOP-QOS4C85" /
project="Codex" / turn_count=0 で記録されている。
この1件は履歴として残す。
（履歴1行の見た目のために本番DBを直接 UPDATE する前例を作らない。
  turn_count は正しい値を復元できず、device と project だけ直すと
  部分的に正しい行になってかえって紛らわしい）

修正後の 13:27 開始のセッションでは device="自宅PC" / project="aiusage" /
turn_count=2 となり、session_start から先頭読みできている。
会話本文は入っておらず、_droppedKeys に message / local_images /
local_audio / text_elements / last_agent_message の名前だけが残っている。

agent_sessions に cwd="C:\Users\Gakujun Yamaba"（ホームそのもの）の
claude-code セッションが1件あり、project="C:" のまま残っている。
ドライブレターとホーム除去の両方を直したので、次にこのセッションへ
イベントが来れば "unknown" に更新される。来なければこのまま残る。
DB は直接変更しない。

## upstream への PR 候補

1. `extractSessionId` が Windows パスを分割できない
   （'/' でしか split せず、session_id にフルパスが入る）
2. cost_source を価格の有無で判定していない
   （claude-code.ts / codex.ts だけが model === 'unknown' で判定し、
     価格表に無いモデルでも cost=0 / cost_source='pricing' になる。D15）
3. `extractProjectFromCwd` が存在しないプロジェクト名を作る2件
   ・ドライブレターを返す（C:\work\myproj → project='C:'）
   ・ホーム除去の正規表現が末尾スラッシュを必須にしているため、
     cwd がホームちょうどだと project='Users' になる
     （C:\Users\alice、/Users/alice、/home/alice。プラットフォーム共通）
   同じ関数の同じ種類のバグなので1つにまとめる。
4. `serve` が無条件に 0.0.0.0 で listen する（D16）
   ※ 挙動変更を伴うため、PR より先に issue で意図を確認すべき。
     upstream が LAN ダッシュボードを意図している可能性がある
5. `ensureAiusageDir` に呼び出し元が無く state.json が作られない
   ※ upstream に対しては ingest トークンではなく
     deviceInstanceId が 'unknown' になる問題として説明すること。
     ingest トークンは我々の追加機能であり upstream には無い
6. cli のテストが core のビルド済み dist を参照する
   （core を変更してもビルドするまで反映されず、落ちるべきテストが通る。
     package.json に pretest を1行）

7. **同期の同意内容を利用者に見せる経路が無い**
   SYNC_FIELDS は「同意画面が示すフィールド一覧」として書かれ、
   同意フィンガープリントもここから作られる。
   ところがこの定数を参照しているのは config.ts だけで、
   **CLI も API も画面もこの一覧を表示しない。**
   `aiusage init` と `/api/config` の PUT は、同期の設定を保存した
   その時点で副作用として同意を記録する。
   利用者が「何が外部へ送られるのか」を見る機会がどこにもない。

   この構造のせいで生じている具体的な症状が、宣言と実態の不一致:
     宣言 15項目 / 実送信 18項目
     差分は platform / sourceFile / cwd
     sourceFile はログファイルのパス、cwd は作業ディレクトリの絶対パス
   一覧をどこにも出さないので、この食い違いは誰の目にも触れず、
   フィンガープリントも15項目から作るため自動でも検知されない。

   直すべきものは2つあり、順序がある:
     (a) 同期を有効にする前に一覧を提示して明示的な同意を取る
     (b) その一覧を実送信に一致させる
   (b) だけを直すと「正確だが誰も読まない一覧」になる。

   **※ 他の候補と性格が違うので、単独の issue として出すこと。**
   1・2・3・6・8 は表示や解析の不備で、直せば挙動が良くなるだけ。
   これは開示の不備であり、
   「利用者が同意したつもりの内容と、実際に外部サービスへ
   送られる内容が食い違っている」という別種の問題になる。
   まとめて出すと埋もれる。

   我々の側では 64e6d4d で (b) だけ直した（D24）。
   フィンガープリントが変わるため既存の同意は取り直しになるが、
   それが正しい挙動だと判断している。

8. platform が端末に伝わらない。**原因が2つある**
   症状は1つ（レコードの platform が空）だが、別々の原因が2つある。
   1つの issue にまとめてよいが、両方書くこと。

   (a) `mergeSyncedRecordsIntoRecords` の INSERT が platform を挙げていない
       synced_records は値を持ち、records も v4 以降は列を持っているのに、
       マージが列名を書いていない。他機から来た行が空になる。

   (b) パーサに渡す platform が config.platform だけから来る
       `runParse` の `const devicePlatform = config?.platform` にフォールバックが無い。
       config.platform を書くのは `aiusage init` だけなので、
       それを通していない config では undefined になり、
       **ローカルで解析した行も全部空になる**。
       すぐ下にある platform のバックフィルも `if (devicePlatform)` で
       守られているため、一度も走らない。
       同じ関数の device は `config?.device || hostname()` と
       フォールバックしているので、platform だけが取り残されている。

   本番では (b) により records 13,280行が全件空だった。
   我々の側では devicePlatform に `os.platform()` のフォールバックを足し、
   バックフィルの条件を source_file ではなく device_instance_id に変えた
   （`source_file NOT LIKE 'synced/%'` は「他機由来」の代用として
   機能しなくなっている。実 source_file を持ったまま届く行があるため）。

9. **テストスイートを流すと開発機の実データが消える**
   `cleanAll(db)` は `join(AIUSAGE_DIR, 'watermark.json')` を
   `unlinkSync` する。`tests/commands/clean.test.ts` はこれを
   モックせずに6回呼ぶので、**開発機の `~/.aiusage/watermark.json` が
   毎回削除される。**

   watermark は「各ログをどこまで読んだか」の記録なので、
   消えると常駐 serve の取り込みが止まる。プロセスは生きたまま、
   通知も出たまま、ダッシュボードも 200 のままで、
   **取り込みだけが静かに止まる。**
   実際にこのマシンで38分止まった。

   テスト自身がこの問題を認めたうえで、迂回して通している:

       // We can't easily test the watermark deletion since cleanAll uses AIUSAGE_DIR
       // But we verify the function doesn't throw when watermark doesn't exist
       expect(result.watermarkRemoved).toBe(false) // no watermark in test AIUSAGE_DIR

   `~/.aiusage/watermark.json` を持たない開発機を前提にしている。
   しかも同ファイル内で**先に走る5つの cleanAll が既に本物を消して
   いる**ので、この行に到達する頃には無く、`false` が通る。
   壊した後に壊れていないことを確認している形になっている。

   我々の側では `cleanAll(db, aiusageDir = AIUSAGE_DIR)` と引数化し、
   テストは一時ディレクトリを渡すようにした。
   引数化した結果、**削除の挙動が初めて検証されるようになった**
   （従来はどのテストも通っていなかった）。

   ※ 1〜3・6・8 と同じ「明確なバグ修正」の束に入れてよい。

方針: 1・2・3・6・8・9 は挙動を壊さない明確なバグ修正なので
1つの PR にまとめてよい。4・5 は影響が大きいので個別に issue から始める。
7 は単独の issue。まだ作成していない。

## バックアップ

- `~/.aiusage/backup-v12-20260829/` プロジェクト開始前
- `~/.aiusage/backup-v19-20260830/` Codex ログ追尾を動かす直前（直近の安定状態）
  ※ v19 は空テーブルを足すだけなので、内容は v18 適用後と同じ。
- `~/.aiusage/backup-pre-claude-cli/` `~/.claude` 系（別目的・保持）
- `~/.claude/settings.json.pre-notify-hooks` hook 追記前（sha256 3c0ef1dbcf7bb8ee）
- `~/.claude/settings.json.pre-stage3` 段階3 直前（sha256 6f9ab1067fca9091）
  現在の settings.json は sha256 78c2756b6f49dbd6。
  戻すには: copy settings.json.pre-stage3 settings.json
  .ps1 3本と task-times/ は残してあるので、復元すれば即座に元に戻る。
  現在の settings.json は sha256 bbfbead44827f015（案A の CLI ログイン後）。

## 画面の合計トークンが「減る」ように見える件

2回観測され、2回とも **DB は減っていなかった。**

    1回目  18:52:12  9,413,156,213 → 19:04:47  9,372,340,185   −40,816,028
    2回目  20:02:08  8,436,117,369 → 20:06:41  8,264,928,571  −171,188,798

（2回目は二重計上の修正 4e7a5fa 適用後。桁が下がっているのはそのため。）

### 分かったこと ─ 大きい数字だけがアニメーションしている

`packages/web/src/routes/+page.svelte`

    57 行  const tTokens = tweened(0, { duration: 2600, easing: cubicOut })
    342 行 {fmtMain($tTokens)}        ← 大きい合計。**トゥイーン値**
    348 行 {fmtShort(data.inputTokens)} ← 入力。**応答をそのまま**

`loadData()` は毎回 `tTokens.set(0, {duration: 0})` で 0 に落としてから
取得するので、**読み込みのたびに 0 から 2.6 秒かけて上がっていく。**
内訳（入力・出力・キャッシュ）はアニメーションしないので即座に最終値になる。

つまり **表示中の 2.6 秒間、合計と内訳は一致しない。**
その最中に撮った画面は、合計だけが小さい。

観測値をこの曲線に当てはめると:

    1回目  seen/final = 0.995664 → cubicOut で 83.7%  ≒ 読み込み 2176ms 後
    2回目  seen/final = 0.979639 → cubicOut で 72.7%  ≒ 読み込み 1890ms 後

どちらも普通に画面を撮る時間帯に入る。
2枚が別ブラウザだったことも、片方が読み込み直後だったことで説明が付く。

### 実際に再現した（2026-08-31 20:12、複製に対して）

内訳が 20.8M / 15.2M / 8.4B と正しく出ている画面で、
**大きい合計が 0 のまま 3 秒以上表示され続けた。**
DOM を 80ms 間隔で 40 回サンプリングして確認。
両者は「値の全部」ぶん食い違いうる。

### DB は減っていない（2回目の実測）

19:55〜20:12 に `updated_at` が動いた行:

    19:55  2行  input 4      output 2,390  cache_read 1,143,834  cache_write 3,745
    19:57  1行  input 2      output 1,553  cache_read 575,828    cache_write 2,857
    20:00  1行  input 2      output 2,039  cache_read 580,238    cache_write 2,857
    20:05  1行  input 2      output 1,178  cache_read 585,134    cache_write 2,870

`synced_records` は**この時間帯 0 行**。増えただけで減っていない。

    20:02 の観測値      8,436,117,369
    ＋20:05 の行            +589,184
    ────────────────────────────────
    20:09 の実測        8,436,706,553   ← 一致

### 除外できたもの

  ・`thinking_tokens` は**全行 0**。動きようがない
  ・`cache_write_tokens` は全体で 110,832,001。
    171,188,798 より小さく、単独では差を作れない
  ・期間（all / day / week / month / last30）のどれも 8,264,928,571 を出さない
  ・端末別（unknown / 職場PC / ノートPC）のどれも出さない
  ・171,188,798 に一致する日・モデル・ツール・セッションは無い
    （最も近いセッションで 169,490,845、170万ずれる）
  ・同じクエリを2回続けて実行しても値は同一
  ・削除経路は走り得ない（retentionDays 未設定、
    deleteRecordsBySourceFile は呼び出し側なし）

### 次に同じことが起きたら

**まず画面を撮り直すこと。** 読み込みから3秒以上おいてから撮る。
それで数字が変われば、これ。

DB を疑う前に、この4つを見れば切り分けが済む:

    1. 内訳（入力・出力・キャッシュ）が2枚で同じか
       → 同じなら合計だけの問題＝アニメーション
    2. updated_at がその時間帯に動いた行と列ごとの差分
    3. thinking は常に 0、cache_write は1億台
       （桁で当たりが付く）
    4. /api/summary を2回叩いて値が揃うか

### 未解明のまま残すこと

**1回目の −40,816,028 は追跡を打ち切った。** 当時の画面を再現できない。
2回目の観測はアニメーションで説明が付き、1回目も同じ曲線に乗るが、
**「その画面が実際に読み込み中だった」ことは確認していない。**
状況証拠であって、証明ではない。

### 直すべきもの（未実施）

合計だけが 0 から動くのをやめる。
内訳と同時に確定させるか、少なくとも `loadData()` の
`tTokens.set(0)` をやめて前の値から動かす。
**画面を撮ると嘘の数字が写る状態**が、2回続けて調査を発生させている。

## ウィジェットは AIUSAGE_HOME で隔離できない（起票・未着手）

`resolveAiusageDir` を通らず、`homedir()` から直に組み立てている箇所が8つある。

    widget/src/main.ts:25      DB_PATH       = join(homedir(), '.aiusage', 'cache.db')
    widget/src/main.ts:26      PORT_FILE
    widget/src/main.ts:27      FX_CACHE_FILE
    widget/src/main.ts:274     dir
    widget/src/settings.ts:17  SETTINGS_PATH
    widget/src/settings.ts:43  dir
    widget/bin/launcher.js:9   aiusageDir

**`AIUSAGE_HOME` を設定しても、必ず本番の `~/.aiusage/` を開く。**
CLI と serve は複製に対して検証できるが、ウィジェットだけはできない。

書き込み事故は起きない（main.ts:54 と 400 で `readonly: true`）。
ただし**古いウィジェットが新しいスキーマを読む経路**は開いている。

見つかった経緯: フェーズ3の洗い出しで、grep の条件に
「homedir から直に組み立てている箇所」を足して初めて出た。
`AIUSAGE_DIR` だけを引くと**0件**になる。
語彙が列挙の範囲を決める、の実例。

現在ウィジェットは使用していないので優先度は低い。
直すなら `resolveAiusageDir` を import する形に変えるだけ。

## 金額の注記を出していない画面（既知の穴・意図的）

`CostCaveats`（価格未設定 N 件 / 内訳不明 N 件）を出しているのは
**ホーム・/cost・/overview・/models・/sessions・/projects** の6画面。

件数はどれもその画面のスコープ（期間・端末・ツール）に追随する。
API 側は `unpricedScopeFor(dr, df, tf)` を共有しており、
画面ごとに条件を書き直していない。

### 出していない場所と理由

    /tool-calls        金額を出すが、主役はツールの呼び出し回数。
                       帯を足すほどの誤読の余地が無いと判断
    ウィジェット        別プロセス・別DB接続で、現在未使用。
                       そもそも AIUSAGE_HOME が効かない（別項）
    CLI summary        端末で見る数字。統計ラインが出すのは合計だけで、
                       内訳不明の説明を出す場所が無い
    agent-sessions     エージェント画面はセッションの**状態**を見る場所で、
                       金額は主役ではない

**黙って落としているのではなく、対象外と判断したものである。**
本番の該当行は37件（内訳不明）で、全画面に機械的に足す費用に見合わない、
という判断。行数が桁で増えたら見直す。

## 恒常的に赤いテスト11件（`tests/sync/s3.test.ts`・原因未調査）

    npx vitest run --root packages/cli
    → Test Files 1 failed | 88 passed
       Tests     11 failed | 963 passed

**11件すべて `tests/sync/s3.test.ts`。** 内容は
`constructs correct object key` / `reads file and returns content` /
`handles pagination` など、S3SyncBackend の全ケース。

今回の変更（版の報告・v25）とは無関係であることは確認した。
`git stash` して HEAD だけにしても同じ11件が同じ形で落ちる。

**原因は調査していない。** 直すかどうかは別途判断する。

記録する理由は、この11件が今回どうかではなく、
**赤が常設になっていること自体**にある。
毎回11件赤いのを見ていると、12件目が増えても気づかない。
「s3 のいつものやつ」と読み飛ばす習慣ができた時点で、
このテストスイートは本物の失敗を報せる役に立たなくなる。

同じ形の判断を、価格未設定の警告のときに一度している
（「消せない警告は、警告を無視する習慣を作る」）。
あのときは警告を事実に変えて消した。ここはまだ消していない。

## light テーマの2つの数字（既知・未対処）

テーマの検査を入れて dark の8件を直した際、**基準である light 自身**にも
4.5 をわずかに下回る組み合わせが2つあることが分かった。
ブラウザで実測した値:

    light   --on-accent を --accent の上に置いたとき   4.35
            --text-muted を --surface の上に置いたとき  3.85

    kohaku  （同じ2つ）                                4.57 / 3.77
    dark    （同じ2つ）                                8.12 / 5.52
    terminal（同じ2つ）                               11.63 / 4.44

`--on-accent` が乗るのは公開サインインのボタン（14px の太字）で、
WCAG の「大きい文字」には当たらないので基準は 4.5。
`--text-muted` は補助的な説明文に使われている。

**直していない。** light は既に出荷されており、
ここを動かすと**承認済みのテーマの見た目が変わる**。
これはテーマの追加とは別の判断である。

琥珀のほうは新規なので、同じ取りこぼしを引き継ぐ理由が無く、
`--accent` を 0.58 → 0.56 にして 4.21 → 4.57 にした
（見た目は変わらない）。`--text-muted` は 3.77 のままで、
これは light の 3.85 と同じ水準。**基準に合わせてある**が、
基準そのものが 4.5 を下回っている。

判断が要るのは次の2つ:

  ・light の `--on-accent` / `--accent` を動かすか
    （動かすと全テーマの既定の見え方が変わる）
  ・`--text-muted` の水準を上げるか
    （4テーマ中3つが 4.5 未満。terminal の 4.44 も含む）

## ウィジェットのトレイを利用枠の常在表示にした（段階A・ハブのみ）

トレイアイコンとツールチップだけ。浮遊ウィンドウの中身は**まだ旧のまま**
（トークン・費用・セッション数）で、そちらは A を見てから。

### 本番の `quota_current` に実際に入っているもの

    claude-code  five_hour     39%   resets_at あり
    claude-code  seven_day     59%   resets_at あり
    claude-code  nimbus_quill   0%   resets_at **null**
    codex        five_hour      0%   resets_at あり
    codex        weekly_limit  29%   resets_at あり

**「週」の tier 名は2つのツールで違う**（`seven_day` と `weekly_limit`）。
`weekly` と `daily` は存在しない。
`nimbus_quill` は表示から外した ─ `resets_at` を返さないので、
この表示の半分（リセットまで）が出せない。

### ツールチップ（本番の値、`setToolTip` が受け取る文字列そのもの）

    Claude 5h  40% (2m)  週  59% (3d11h)
    Codex  5h   0% (4h55m)  週  29% (5d15h)

74文字。**Windows の上限は127文字**（`Shell_NotifyIcon` の `szTip`）で、
超えると黙って切られるため、`cred_status` と鮮度の警告行は
**数字より上**に置いている（切られて残るのは先頭だから）。

### アイコン

同じ図形を塗り替えるだけ。`ok`（既存の色）/ `warn`（琥珀）/ `danger`（赤）。
**数字は描かない** ─ 16×16 に入るのは2桁程度で、
4つの値のうちどれなのかを添える余地が無い。

**閾値 70 / 90 は仮。** これらの端末でまだ枠を使い切ったことが無く、
どこが有用な警告になるかの根拠が無い。使ってから決め直す。
（黙った spoke の168時間と同じ立場。）

**古いこと・資格情報が無効なことは、色にしない。**
どちらも「情報が無い」であって「残りが少ない」ではなく、
同じ赤にすると2つが区別できなくなる。言葉で書く。

### Electron の main は Windows で標準出力を持たない

`console.log` は**どこにも出ない**（実測。パイプに繋いで起動しても空）。
起動を断るときの1行は `~/.aiusage/widget.log` に追記する。

### Windows 11 は既定でトレイアイコンを隠す

タスクバー右端の `^`（オーバーフロー）の中に入る。**常在させるには:**

    設定 → 個人用設定 → タスクバー
      → タスクバー コーナーのオーバーフロー → AIUsage Widget をオン

これをしないと「常在」にならない。

### タスクバーの天気の場所には入れない

あの表示は Windows 自身が持っており、第三者は入れない。
ウィジェットボードは MSIX パッケージ化とウィジェットプロバイダ登録が要り、
個人ツールには重すぎる。**通知領域が代替である。**

## ウィジェットの窓を利用枠にした（日本語を追加）

窓の主役が利用枠になった。トレイのツールチップが要約、窓がその詳細で、
**同じ1回のクエリと同じ規則**から作る（両方が同時に違うことを言えない）。

    利用枠
    Claude
      5時間  ░░░░░░░░░░   4%  あと 4時間30分
      週     ██████░░░░  60%  あと 3日10時間
    Codex
      5時間  ░░░░░░░░░░   0%  あと 4時間59分
      週     ███░░░░░░░  29%  あと 5日14時間
    nimbus_quill は表示していません（リセット時刻を返さないため）

**`nimbus_quill` を外した事実は窓の最下部に1行出す。**
データに在って画面に無い行は、最初から集めていない行と区別が付かない。

予測・ペースは入れていない（`/quotas` の仕事）。

### 旧セクションは消さず、既定で畳んだ

`showUsage`（トークンと費用）を新設し、既定 off。
`showCost` / `showTokenBreakdown` / `showHeatmap` も既定 off に変えた。

**既存のトグルだけでは足りなかった。** 今日/過去N日の合計と
最多モデル・最多ツール・セッション数には**元からトグルが無く**、
常に出ていた。それらを1つにまとめる `showUsage` を足している。

消していないのは、「どうでもいい」と「要らない」が違うから。
トグルを戻せば全部戻る（実機で確認済み）。

### 日本語

`ja` を追加し、**OS の言語が日本語なら既定で ja**
（`app.getLocale()` を whenReady 後に読む。保存済みの選択は上書きしない）。
言語ピッカーにも `日本語` を追加した ─ 追加を忘れると、
**UI は日本語なのに日本語を選べない**という状態になる（実際になった）。

### ★ i18n は2箇所ある

    packages/web/src/lib/i18n.js       ダッシュボード（en / ja / zh）
    packages/widget/src/i18n.ts        ウィジェット（en / ja / zh）

**キー名も構造も別で、互いを知らない。** 言語を1つ足すたびに2箇所直す。
統合するかどうかは別途判断。いまは「2箇所ある」ことだけ記録する。

### 直した2件（作業中に出たもの）

**(a) データを組み立てる経路が2つあり、形が違った。**
描画側が最初に取りに来る `widget:get-data` と、
その後に主プロセスが送る `widget:data-update` が別々に作られていた。
利用枠を後者だけに足したところ、**窓がヘッダだけ描いて中身が空**になった
（先に届くのは前者で、そちらは利用枠を知らない）。`buildPayload()` に統合。

**(b) その失敗が黙って捨てられていた。**
`catch { /* silently skip */ }` があり、Electron の main には
コンソールが無いので**原因を知る手段が無かった**。
`widget.log` に書くようにした。**空のパネルは状態ではなく、
状態のふりをした失敗である。**

### CSS 変数の名前がパッケージ間で違う

ウィジェットは `--border` / `--text-primary` を使う。
web は `--border-subtle` / `--text`。web の名前で書いてしまい、
**空セルが透明になって 3% のバーが「何も無い」に見えた**。

web には `check-css-vars.cjs` があるが、**ウィジェットには無い。**
同じ検査を持たせるかは別途判断（未着手）。

### トレイ設定の一覧では `Electron` と出る

`app.setAppUserModelId('com.juliantanx.aiusage-widget')` を
ウィンドウ作成前に呼ぶようにしたが、**表示名は変わらなかった**（実測）。

Windows はあの一覧の名前を**実行ファイルのバージョン情報**から引く。

    electron.exe  FileDescription : Electron
                  ProductName     : Electron

未パッケージのビルドは `electron.exe` をそのまま起動しているので
`Electron` になる。AUMID はタスクバーのグループ化と通知の帰属には効くので
設定自体は残す。

**直すにはパッケージ化が要る（未実施）。見積もり:**

  ・`electron-builder.yml` は既にある（appId / productName / nsis 設定済み）
    → `pnpm pack` を通すだけなら**設定作業はほぼ無い**
  ・費用は署名。未署名だと SmartScreen の警告が出るので、
    実用にはコード署名証明書（年額）が要る。**ここが本体**
  ・運用の分岐: パッケージ版はインストール先で動くので、
    `aiusage-update.cmd` の更新経路から外れる。**更新経路が2つになる**
  ・中間案として `rcedit` で exe のバージョン情報だけ書き換える手もあるが、
    対象が `node_modules/.pnpm` の共有ファイルで `pnpm install` で戻る

**名前1つのためにやることではない、というのが現時点の判断。**
README に「一覧では `Electron` と出る」と書いてある。

## CSS 変数の名前体系が2つある（検査で塞いだ。名前は揃えていない）

    役割              web                widget
    ─────────────────────────────────────────────────────
    本文の色          --text             --text-primary
    薄い境界          --border-subtle    --border
    強い境界          --border-medium    --border-medium
    面                --surface          --surface
    危険色            --danger-fg 他     --danger（今回追加）

**web は70個超、widget は16個。** 別プロセス・別レンダラで、
片方に無い名前がもう片方にある。

### 揃えていない理由

名前を揃えると**見た目の変更を伴う**（widget の `--border` は
web の `--border-subtle` と値が違う）。テーマ追加とは別の判断であり、
いま混ぜると「検査を入れた」変更に見た目の変更が紛れる。

**検査があれば「web の名前で書いた」はその場で落ちるので、実害は消える。**
揃えるかどうかは別途判断。

### 検査は共有した（コピーしていない）

    scripts/check-css-vars.cjs <package-dir>

    packages/web/package.json     pretest: 上記 . && check-theme-vars.cjs
    packages/widget/package.json  pretest: 上記 .

引数は**必須**にした。既定値を持たせると、間違ったディレクトリを
静かに調べて「問題なし」と言う ─ 誰も疑わない答えになる。

`check-theme-vars.cjs` は web に残した。テーマは web にしか無い概念で、
共有すると widget 側で常に「テーマが1つも無い」と言い続けることになる。

### 経緯

今日 web にこの検査を入れて未定義参照を潰した。**その数時間後、
検査の無い widget で同じ型が出た** ─ web の名前で書いた結果、
空セルが透明になり **3% のバーが「何も無い」に見えた**。
色が違うのではなく存在が消える壊れ方で、目で気づきにくい。

「同じ計算が2箇所」を4系統9実装まで数えた直後だったので、
2つ目のコピーは作らなかった。

## ウィジェットが通知を出す（トースト1本・ハブのみ）

新しい配送経路は作っていない。`notifications` テーブルを readonly で
30秒ごとに読み、**新しい行に気づくだけ**。DB には一切書かない。

### 方式は実機で選んだ

4案のうち2つを実際に発火させた:

    tray.displayBalloon()   届く。ただし Windows 11 は**トーストに変換する**
    new Notification()      届く

**同じ経路だった**ので、選択肢は実質1つ。Electron の `Notification` を使う。
窓の中のバナーは作らない（窓を閉じている間は届かないため）。
アイコンの色は利用枠の深刻度に使っており、通知と兼用すると
**どちらの理由で赤いのか分からなくなる**ので使わない。

### 畳み方 ─ `dedupe_key` では畳めない

    総行数 767 / distinct dedupe_key 767（全部ユニーク）

webpush のキーは discord のキーに `webpush:` を前置した別の値。
**畳めるのは `(event_type, subject_kind, subject_id, created_at)`**。
767行 → 467件で、discord の行数と一致する。
プレフィックスを剥がす実装はチャンネルが増えた時に壊れる。

### 再生しない

地点は**ウィジェットの設定ファイル**に持つ（DB は readonly）。
初回は何も出さず「これ以降」から始める。
端末をまたいで共有しない ─ 「見たか」は画面の事実であって出来事の事実ではない。

**地点は表示より先に保存する。** 途中で落ちたとき、
片方は「1件見逃す」で、もう片方は「毎回の起動で同じものが出続ける」。
後者のほうが人は気づくし、腹も立つ。

バーストは**最大5件**まで表示し、残りは件数をログに書いて捨てる。
持ち越すと、忙しい1分が1時間かけて流れてくる。

### ★ AUMID の DisplayName は効かなかった

`HKCU\Software\Classes\AppUserModelId\<AUMID>` に `DisplayName` を
書いてみたが、**通知センターのグループ名は AUMID の文字列のまま**だった。

確認した手順（全部実機）:

  1. `DisplayName` と `IconUri` を書く → 変わらず
  2. `IconUri` は画像パスを期待するので削除、`DisplayName` のみ → 変わらず
  3. `HKCU\...\Notifications\Settings\<AUMID>`（通知プラットフォームの
     キャッシュ）も消して新しい通知を発火 → **変わらず**

    通知センターの見出し: com.juliantanx.aiusage-widget

**コードは入れていない。** 観測できる効果が無い書き込みを
利用者のレジストリに残す理由が無いため。書いたキーも削除済み。

**試していないこと:** サインアウト／再起動後に効く可能性
（通知プラットフォームは `wpndatabase.db` にキャッシュする）。
やるならその1点だけを確かめてから。

### サイレントモードだとバナーが出ない

この端末は現在**サイレントモードが有効**で、
通知センターに「優先通知とアラームのバナーのみが表示されます」と出る。
**トーストは届いて通知センターに残るが、画面には出ない。**
利用者の設定であって実装の問題ではないが、
「出ない」と言われたときに最初に見る場所なので README に書いた。

## 通知は「作業完了」だけ・無音に絞った

    出す:     waiting_for_user + stop          🟢 作業完了
              waiting_for_user + stop_failure  🔴 処理エラー終了
              failed                           🔴 異常終了
    出さない: 上記以外すべて

**判定は payload で行う。title の文字列は見ない** ─ 題名は利用者の言語で
書かれており、翻訳した瞬間に壊れる。payload はどの言語でも同じ2語。

本番に実在する `session_status` の payload は7通りあり、
そのうち2つが該当する（3つ目の `failed` は本番にまだ無い）:

    waiting_for_user / stop            ← 出す（正常完了）
    waiting_for_user / stop_failure    ← 出す（処理エラー終了）
    failed / *                         ← 出す（異常終了。本番には未出現）
    waiting_for_user / session_start   出さない
    waiting_for_permission / permission_request  出さない
    completed / session_end            出さない
    completed / stop                   出さない
    completed / process_scan           出さない

`quota_threshold` / `quota_credential` / `session_escalation` も出さない。

**payload が読めない行は出さない。** 不明を「たぶん大丈夫」にすると、
この絞り込みが防ぎたかったものがそのまま出る。

`silent: true` で Windows の既定音は鳴らない。**表示は出る。**

判定の3つは、ハブ自身が使っている規則と同じものにした
（`packages/core/src/notification-rules.ts`）。`stop_failure` を status ではなく
kind で見るのも同じ理由 ── **stop_failure は status を waiting_for_user のまま残す**ので、
status だけでは正常完了と区別できない。規則ファイルも同じ順で見ている。

`failed` は本番の767行に1件も無いが**先に入れた**。ハブは作れる状態にあり、
初めて起きた瞬間は「ウィジェットが見ていなかった」と分かるのに最悪の時機である。

通し（隔離DB、実機）: 8種類16行を入れて**3件だけ**が出た。
🔴 異常終了 / 🔴 処理エラー終了 / 🟢 作業完了 の3つで、
出してはいけない5種類はどれも出ていない。

**音は引き続き無し（`silent: true`）。エラーだけ鳴らす形にはしない** ──
制約は「音を出せない場面がある」ことであって重要度ではなく、
会議中に鳴るエラーは避けたかったものそのものだから。
区別は絵文字が付けており、こちら側に足すものは無い。

### 種類ごとの設定は作っていない

いま要るのは1種類だけで、使われない設定を先に作ると、
次に増やすとき何が実際に使われているのか分からなくなる。

## 窓の高さを中身に追随させた

    利用枠のみ        500 → 238  （英語 227）
    設定パネル              569
    旧セクションを戻す      389

下端は常に 1028 のまま ─ **縮んでも窓は動かない。**
トレイの上端に貼り付ける計算なので、高さが変わると上端だけが動く。

### 原因は「送っている箇所が無い」ではなかった

指示は「送っている箇所は0件」だったが、**実際には全部揃っていた**:

    renderer/App.svelte:116  reportWindowHeight()
    renderer/App.svelte:150  ResizeObserver
    preload.ts               resizeWindow
    main.ts                  ipcMain.on('widget:resize-window')

計測して送り、受け取り、正しい高さを計算していた。ログで確認した:

    PROBE resize-window received 51
    PROBE resize-window received 238

**効かなかったのは `win.setSize()` のほう。**
`resizable: false` で作られたウィンドウは、Windows では
**setSize も黙って無視する**（ドラッグの取っ手だけでなく）。
`setResizable(true)` → `setSize` → `setResizable(false)` で通した。
利用者が縁をドラッグできる状態にはならない。

`MIN_WINDOW_HEIGHT` は 320 → 120。320 はトレンドグラフと3行の統計が
あった頃の値で、中身が変わっても残り、**下限として効いていた**。
120 は実測に基づく: 起動直後に一度だけ 51（ヘッダのみ）が飛んでくるので
その上、実際の中身 238 の下。

余白と行間は詰めていない。**いま読めていることのほうが価値がある**と判断した。

## ウィジェットの大きさと中身を選べるようにした

### 拡大率（トレイの右クリック / Ctrl + `+` `-` `0`）

    範囲 0.7 〜 1.5、刻み 0.1、既定 1.0、設定に保存

範囲は両端を見て決めた。0.7 未満は割合の数字が離れて読めなくなり、
1.5 を超えると「あと 2日21時間」が折り返す ─ **常在物が絶対に
やってはいけないこと**。刻み 0.1 は、0.05 だと2回押さないと変化が分からないため。

窓のドラッグにはしていない。**窓は中身に追随する**ので、
広げても増えるのは余白で、次の更新で戻される。
拡大率なら文字・バー・窓が一緒に動き、追随がそのまま効く。

実測（すべて右下の角 1893,1028 は不動）:

    0.7   216 x 175
    1.0   309 x 252
    1.5   462 x 374

### 角を固定する

リサイズ時は `positionWindowNearTray()` を呼ばず、
**右下の角を保って** x, y を計算する。トレイに合わせて中央に置き直すのは
最初に出すときは正しいが、中身が変わるたびに横に飛ぶ。

### 中身 ─ 行は固定していない

`quota_current` にあるものをそのまま出す。決め打ちは元から無かったが、
`copilot` の表示名を足した。**利用枠を報告できるのは3つだけ**
（`claude-code` / `codex` / `copilot`。CLI の quota.ts）。
Gemini や ChatGPT のウェブ版には取得口が無く、
**行を足すのは表示の設定ではなく取得先の実装**になる。README に明記した。

### 詳しさは3段（項目ごとのトグルにしない）

    メーターだけ      224 x 252
    ＋ 割合           224 x 252
    ＋ リセットまで   309 x 252   ← 既定

項目ごとにすると 2^n 通りになり、意味のある組み合わせは3つしかない。
使われない設定は、次に増やすとき「何が実際に使われているか」を分からなくする。

**メーターだけと ＋割合 が同じ大きさなのは、行ではなくヘッダが下限だから。**
アイコン＋名前＋時刻＋ボタン3つで約224px あり、行はそれより狭い。
CSS の下限は 200 に置いてあるが、実際に効いているのはヘッダのほう。

### ツールごとの表示・非表示

`quota_current` にあるものを一覧にしてトグル。
全部外すと「表示するものがありません。」の1行。**空の窓は出さない。**

    Codex を外す   309 x 252 → 224 x 185
    両方外す                → 224 x 120

### 窓が中身に追随するために直したこと

`.panel` が `width: 100vw` だった。**窓の幅を測っても窓の幅が返るだけ**で、
広がることはあっても縮むことはできなかった。`max-content` にして、
幅も高さもレンダラが測って送るようにした。

下の注記（nimbus_quill の行）は `width: 0; min-width: 100%` にして
**幅の計算から外した**。そうしないと注記が一番幅の広い要素になり、
どの段でも同じ大きさになる（実際そうなっていた: 3段とも 334px）。

設定パネルには `min-width: 340px` を別に置いた。中のコントロールは
flex 行で固有幅を持たないため、max-content だと 240px まで潰れる。

## nimbus_quill の注記を主パネルから設定パネルへ移した

「黙って落とさない」という当初の目的は果たされている（読まれ、理解され、
そのうえで不要と判断された）。残っていたのは**恒久的で・対処できず・
変わらない一文が、最小の常在物の中で場所を取っている**状態で、
ホーム画面から地色の注記を外したのと同じ形。

設定パネルに移した:

    表示していないもの
      nimbus_quill        リセット時刻を返さないため

**名前で決め打ちにしていない。** 除外された tier を data から拾い、
理由も行から導く:

    その tier の全行が resets_at を返さない  → 'no-reset-time'
    それ以外（この版が label を持たない）    → 'unknown-tier'

`nimbus_quill` を定数に書くと、**次に同じ状態の tier が来たときにまた
黙って落ちる** ─ この仕組みが防ごうとしていたことそのものになる。

除外が0件なら節ごと出ない（実測: 設定パネル 800px → 687px、節が消える）。

### 寸法の前後

注記は以前この窓の最大幅を決めていた（3段とも334px）。
`width: 0; min-width: 100%` で幅の計算からは外してあったが、
**要素ごと無くなって高さが縮んだ**:

    メーターだけ      224 x 252  →  224 x 212
    ＋ 割合           224 x 252  →  224 x 212
    ＋ リセットまで   309 x 252  →  309 x 212

幅は変わらない。**注記を折り返させた時点で幅の決定権は行に移っていた**ので、
残っていたのは注記2行ぶんの高さ40pxだった。右下の角は不動。

### ついでに ─ 共有した検査が即日また効いた

設定パネルの tier 名を等幅にするつもりで `var(--mono, monospace)` と書き、
`check-css-vars` が**その場で落とした**:

    src/renderer/components/SettingsPanel.svelte:411  --mono
      (has a fallback, so it renders and hides the mistake)

web には `--mono` があり widget には無い。フォールバック付きなので
**画面上は何も起きず**、気づく手段は無かった。検査を共有した当日に
同じ型が2度目に出たことになる。

## `aiusage widget` がワークスペースのビルドを起動するようになった

`resolveElectronBin()` は `where aiusage-widget` だけを見ており、
PATH に無ければ「インストールしてください」と案内していた。
**その案内に従うと公開版が入り、今日の変更が1つも無い窓が出る。**
開発している本人が自分のビルドを起動できない状態だった。

    この repo にある        → packages/widget を electron で起動
    無く、PATH にある       → それを起動
    repo にあるが未ビルド   → ビルドを案内する（公開版は案内しない）
    どちらも無い            → 従来のインストール案内

**どちらを起動したかを必ず1行出す。**

    aiusage widget started from this checkout: ...\packages\widget
    aiusage widget started from the installed package: ...\aiusage-widget.cmd

グローバル版とこの checkout の版は**別のプログラム**で、
黙って選ぶと今日と同じ混乱になる。

### 実装で気をつけたこと

**この木を先に見る。** CLI とウィジェットは1本の木からビルドされた片割れで、
checkout の CLI からグローバルのウィジェットが出るのは2つの版を混ぜている。
`findWorkspaceWidget()` は自分の位置から上へ辿るので、**見つかるのは
いま動いている CLI が入っている木だけ**。グローバル CLI から走らせれば
見つからず PATH に落ちる ── 規則が自動的に正しくなる。

**repo は `..` の数を数えずに探す。** このファイルは tsx では
`src/commands`、ビルド後は `dist` から動き、深さが違う。
自分の位置から上へ辿って `packages/widget/package.json` を探す。

**electron の場所は推測しない。** `createRequire(widget/package.json)('electron')`
で、そのパッケージ自身が解決するのと同じ経路で聞く。
pnpm の配置は pnpm の問題のままにできる。

### 実測（3分岐すべて）

    ビルドあり    → 起動し、checkout のパスを表示。窓が1つ出た
    ビルド無し    → "Widget not built at ..." ＋ pnpm build の案内、exit 1
    repo 外       → 従来のインストール案内、exit 1

### 見つけた別のバグ ── PATH 版はそもそも起動できていなかった

`spawn(command, [], { shell: false })` は Windows で **EINVAL で落ちる**。
npm が PATH に置くのは `aiusage-widget.cmd` で、
Node は .cmd をシェル無しで起動することを塞いでいる。
**この分岐は Windows で一度も動いたことが無かった**
── 比べる相手ができて初めて分かった。

cmd.exe を直接呼び、パスを引用して `windowsVerbatimArguments` で渡す形にした。
**`/s` は付けない。** `/s` は外側の引用符を剥がして残りをそのまま使う指示で、
引用符だけがパスを繋いでいる場合には逆効果になる。実測:

    /d /c     空白入りのパス → 起動する
    /d /s /c  空白入りのパス → 黙って起動しない

この端末のホームは2語（空白入り）なので、`where` が返す長い形は必ず空白を含む。

### テストが1件落ちて、それも本物だった

`tests/commands/widget.test.ts` が `node:fs` を丸ごとモックし、
`existsSync` が**何に対しても true** を返していた。
その結果、木を探す歩行が**1回目の候補で成功**してしまう
（`src/commands/packages/widget` という実在しない場所）。
モックが「何がディスクに在るか」を言わないと、**どの分岐が走るかをモックが決める**。
PID ファイルだけ true を返すように直した。

## ウィジェットがハブへログインする形になった（依存の除去）

    いま   fetch だけ
    以前   ローカルDBを better-sqlite3 で直接読む
           → ネイティブバインディング → Electron ABI
           → prepare-native → node-gyp
           → **CLI を止めた経路そのもの**

消えたもの:

    bin/install-native.js       postinstall
    bin/prepare-native.js
    dist/native/
    better-sqlite3 / @electron/rebuild / prebuild-install / @types/better-sqlite3
    packages/widget/package.json の postinstall・prepare:native・rebuild:*

**ABI 不一致という問題の種類ごと無くなった。**

### 経路は1つ

**ハブも自分の 127.0.0.1 にログインする。** 隣にあるDBを読まない。
2つ経路があれば、鮮度の規則も欠損の扱いも2組になり、いずれ画面の前で食い違う。
昨日 recalc 2実装・union 3実装を1つにしたのと同じ理由。

    spoke  config.hubForward.url（既に入っている）
    ハブ   ~/.aiusage/.serve-port から http://127.0.0.1:<port>
    どちらも widget の設定で上書きできる

### パスワード

`~/.aiusage/config.json` の `credentials`（CLI と同じ場所・同じ形、0600）。

  ・`hubDashboardPassword` … 設定パネルで入力したもの。**優先**
  ・`dashboardPassword` … この端末の serve 自身のもの。
    **ハブがこの端末自身のときだけ**使う

後者の意味: ハブでは**誰も何も入力しなくてよい**。serve が確認している
パスワードは既にこのディスクにあり、自分に対して自分のパスワードを
打ち直させるのは儀式でしかない。**リモートのハブには使わない** ──
spoke のパスワードは spoke 自身のもので、
求めてもいない相手に秘密を差し出すことになる。

Cookie は**メモリのみ**。有効期限は7日で、パスワードからいつでも作り直せるので、
ディスクに置くのは秘密の置き場所を1つ増やすだけになる。401 を受けたら
1度だけ入り直して再試行する。

### ★ 信頼境界（記述を訂正した）

以前ここに「使用量とコストと通知本文を読まれる」と書いたが、**浅かった**。

ハブは `includeAssistantMessage: true` で動いている。
**通知の本文には AI の応答の抜粋が入る。3台分すべての。**

  ・読めるのは数字ではなく**作業の内容**である ──
    何を作っていたか、どのプロジェクトで、どんな言葉で
  ・**方向が逆になる。** これまでは職場PC→ハブだった。
    今回はハブ→職場PC で、集まった3台分が各端末に戻る

書き込み権限は増えない。ダッシュボードを読めることは、
そこに何かを入れられることを意味しない（ingest トークンは別）。

この記述は `packages/widget/src/credentials.ts` の docstring にも同じ内容で置いた。

### 繋がらないとき

起動時に届かなければ**起動しない**。理由と URL をログに書く:

    cannot reach the hub at http://127.0.0.1:3999 (unreachable). Not starting.

動作中に届かなくなったときは、**古い数字を出さず**パネルに1行出す
（「ハブに繋がりません（URL）」／「パスワードを受け付けません（URL）」）。
**アイコンの色は変えない** ── 色は利用枠の残りを意味しており、
2つ目の意味を持たせると赤の理由が分からなくなる。

### 挙動が変わった2点

**(a) 門が「quota_current が空か」から「ハブに繋がるか」へ。**
ハブ限定ではなくなり、**どの端末でも意味を持つ**ようになった。

**(b) 通知が全端末のものになる。**
自宅PCの完了が職場PCに出る。端末で絞る設定は**作っていない** ──
使ってみて多すぎたら足す。

### 途中で見つけたこと

`/api/notifications` は **`payload` を返していなかった**（実装前に判明）。
判定は payload で行う決まりなので、これが無ければ実装できない。
射影に追加し、`?since=` も足した（`limit` を超えた瞬間に静かに取りこぼすため）。

パネルは `data` が届いた瞬間に `$:` で文字列を組み立てるので、
**旧セクションのフィールドが無いオブジェクトを渡すと reactive 文が投げ、
パネル全体が描画されない**。ヘッダだけの窓になり、
「中身を失った窓」に見える。`emptyWidgetData()` で常に完全な形を渡す。

### 接続が切れたときの表示（実測。本番は止めていない）

使い捨ての AIUSAGE_HOME で serve を 3998 に立て、ウィジェットをそこへ向け、
**その serve を殺して**確かめた。本番の DB にも serve にも触れていない。

**1回目は失敗した。古い数字が残った。**

    切断前  316 x 240  Codex 5時間 23% / 週 34% …
    切断後  316 x 240  **まったく同じ表示のまま**

原因は、失敗時に送っていたのが `{ hubProblem, hubUrl }` だけだったこと。
パネルは `data` 到着と同時に `$:` で文字列を組み立てるので、
**旧セクションのフィールドが無いと reactive 文が投げ、パネルが再描画されない**。
直前に同じ型を1つ直していたのに、失敗経路のほうを見落としていた。

直したあと:

    切断前  316 x 240  数字が出ている
    切断後  269 x 120  「ハブに繋がりません（http://127.0.0.1:3998）。」
                       **数字は消える**

**「止まったものの最後の値を出し続けない」は、
言うだけでは実現しない。切って見るまで、していたつもりだった。**

ツールチップの文言は同じ `hubProblem` の分岐が設定しているが、
**ホバーの吹き出しはこの環境では画面に取れない**（合成マウス移動では
描画されない。既知）。パネル側のみ実測。

### IPC の payload に型を付けた（現象ではなく形を直した）

`webContents.send` の第2引数は `any` である。だから
**半分だけのオブジェクトを送っても tsc は何も言わなかった。**
今日それで2回同じ壊れ方をした ── 成功経路で1回、失敗経路で1回。

**1回目に直したのは現象（パネルが再描画されない）で、
形（不完全なものを送れてしまう）は残っていた。**
だから次の経路を書いたときに同じことが起きた。

    src/update.ts   WidgetUpdate = WidgetData & { quota, hubProblem, hubUrl }
    main.ts         sendUpdate(update: WidgetUpdate) が唯一の送信口

わざと今朝の形（`{ hubProblem, hubUrl }` だけ）に戻すと落ちる:

    error TS2345: Argument of type '{ hubProblem: HubFailure; hubUrl: string; }'
      is not assignable to parameter of type 'WidgetUpdate'.
      ... is missing the following properties: quota, todayTokens,
      todayCost, rangeTokens, and 7 more.

**次に節を増やして失敗経路を書き忘れたら、ビルドが止まる。**

### ★ preload はサンドボックスで、ローカルモジュールを require できない

チャンネル名を1箇所にするつもりで preload から `./update` を import したら、
**window.widget ごと消えた。**

`contextIsolation: true` で `sandbox: false` を指定していない preload は
サンドボックスで動き、**相対パスの require ができない**。
preload が読み込み時に投げると `contextBridge` も実行されず、
`window.widget` が未定義になる。レンダラの最初の呼び出しが投げ、
`onMount` が中断し、ResizeObserver も張られない。

見た目は**「ヘッダだけの窓」**で、今日3回目の同じ症状だった
（1回目=不完全な payload・成功経路、2回目=同・失敗経路、3回目=これ）。
**症状が同じでも原因は3つとも違う。**

型だけの import は消えるので契約は保ったまま、
**チャンネル名の文字列だけ preload に書き戻した**（理由をコメントに明記）。

### 窓が黙って壊れられないようにした

同じ「ヘッダだけの窓」が3回出て、原因は3つとも違った。
**故障が設計に見えるのが問題だった。** 起動して覗くまで誰も気づかない。

`onMount` は素で並んでいたので、最初に投げたものが残り全部を道連れにした
── ResizeObserver も含めて。窓の高さを決めているのはそれである。

    bridge が無い    → 「ウィジェットの読み込みに失敗しました。トレイから…」
    onMount が投げた → 「ウィジェットの起動に失敗しました：<理由>」
    10秒来ない       → 「まだ値を受け取っていません。」

**ハブの文言とは別にした。** 「ハブに繋がりません」と同じ言葉にすると、
外から見て区別できない ── 次にやることが全く違うのに。

わざと壊して実測（型では捕まらない種類なので）:

    preload を投げさせる  → 赤字「読み込みに失敗しました」・窓は既定サイズのまま
                            （bridge が無い＝resizeWindow も無い。これは正しい）
    onMount で投げさせる  → 赤字「起動に失敗しました：deliberate onMount failure」
                            窓は 360x120 に縮んだ（ResizeObserver は try の外）

### ★ レンダラは型検査されていなかった（17件のエラーが隠れていた）

`declare global` を書いてから気づいた ── **それを検査するものが無い。**

`tsconfig.json` は `"exclude": ["src/renderer"]`。
レンダラは vite が通すだけで、**型は剥がされるだけで読まれていなかった。**
だから `(window as any).widget` が10箇所そのままだった。

`tsconfig.renderer.json` を足して svelte-check を pretest に入れたら、
**既存のエラーが17件出た。** 主なもの:

    App.svelte と SettingsPanel.svelte が WidgetSettings を手書きで再定義していた
      → 2フィールド足りず、SettingsPanel は既に settings.hubUrl を読んでいた
    App.svelte が quota を再定義し hiddenTiers を string[] としていた
      → 実際は { tier, reason } の配列（今日変えた側が古い写しに届いていない）
    ActivityChart の locale が 'en' | 'zh'
      → **ja が抜けていて、日本語でも日付が英語書式で出ていた**
    window.widget?.x() の undefined を | null へ代入（4箇所）

**IPC に型を付けたのと同じ病気である。** 受け取る側が契約を手で書き写す。
今回は写しの方が古かった。全部消して本物を import した。

`svelte.config.js` を足したのは svelte-check がプリプロセッサを見つけられないため
（vite.config.ts が `root: 'src/renderer'` なので、パッケージ直下からは見えない）。

## 2026-09-02 に見つかった壊れ方（分類）

箇条書きではなく分類で書く。**同じものが4回出て、種類は3つだった。**

### (a) 黙って壊れる ── 3回

  1. 不完全な payload（成功経路）
  2. 不完全な payload（失敗経路）
  3. preload がサンドボックスでローカルモジュールを読めない

**原因は3つとも違う。見た目は3回とも同じ「ヘッダだけの窓」だった。**
故障が設計に見えるので、起動して覗くまで誰も気づかない。

1 と 2 が別々に出たのは、**1回目に直したのが現象**（パネルが再描画されない）
**で、形**（不完全なものを送れてしまう）**が残っていたため。**
`webContents.send` の第2引数は `any` である。**見落としたのではなく、見えなかった。**

対処: `WidgetUpdate` 型と単一の送信口。ついでに `onMount` を守り、
故障を描くようにした（コミット `ae62828`）。

### (b) 壊れたと正しく言い、直す手段を閉じた ── 1回

    cannot reach the hub at https://... (unauthorized). Not starting.
    open the widget settings and enter the hub dashboard password.

**その設定は起動しないと開けない。**
メッセージは正しく、出口が無かった。(a) とは別の形である。
壊れたことは言えている。**案内している手段が、案内している側の前提を満たしていない。**

### (c) 壊れずに、別の正しいものになる ── 1回 ★

    config.json に BOM が付く（PowerShell の Set-Content -Encoding UTF8）
      → JSON.parse が失敗
      → configuredHubUrl() が catch して null を返す
      → 接続先が既定の http://127.0.0.1:3847 に落ちる
      → spoke が自分自身をハブとして読む
      → Codex しか出ない（その端末が集めているものだけ）

**エラーは1つも出ていない。表示も正常。中身だけ別物。**

**(c) が一番遅く見つかった。壊れて見えないため。**
(a) は覗けば分かる。(b) はメッセージが出る。(c) は何も言わない。

### 診断について1行

**同じ BOM が、その30分前に調査用の node コマンドを落としていた。**
そこで config.json を疑えば半日は要らなかった。

── ある回で見た文字コードの不具合は、
**そのセッションで書いた全ファイルを疑う理由になる。**
1つのファイルの問題として処理すると、次に同じ手で書いた別のファイルを見逃す。

## 未修正（2026-09-02 時点）

  ・`configuredHubUrl()` と `readConfig()` が parse 失敗を握り潰す。
    **「ファイルが無い」と「あるのに読めない」を分けること。**
    後者は既定に落ちてはいけない。ログと窓に出すこと。
    ── 上記 (c) の直接の原因である

  ・pid ファイルが消えると二重起動を防げない。
    数えるときは `Get-Process electron` の **StartTime の組**で数える

  ・**`ae62828` が push されていない。**
    職場PCは `f2fb3c3` で動作中。
    レンダラの型検査と、グラフの日付の日本語書式が入っていない

  ・`/api/quotas` が毎リクエスト上流を叩く（OPERATIONS.md の 429 の項）

### 同日中に修正したもの

  ・401 で終了する（上記 b）→ 修正済み。
    `unauthorized` では起動し、設定パネルを開いた状態で
    「数字を出すには、ハブのダッシュボードのパスワードが要ります。」を出す。
    `unreachable` は従来どおり終了する（届かないのは相手の問題で、
    この窓に何を打っても変わらない）。
    実測: わざと誤ったパスワードで起動 → 窓が出てパネルが開く →
    その場で正しいパスワードを入れる → **再起動なしで数字が出た**

  ・`widget:get-data` が失敗時に `null` を返していた。
    `pushDataUpdate` は完全な失敗 payload を送るのに、
    レンダラ自身の初回取得だけが `null` を受け取っていたため、
    **起動直後の1回目は hubProblem が見えず、パネルが開かなかった。**
    `currentUpdate()` に一本化した。
    ── **これも「2つ目の経路が独自に失敗を報告する」形である。今回で3度目。**

### 根拠が無い数字（そのまま残っているもの）

  ・トレイの色のしきい値 70% / 90%
  ・`STALE_AFTER_MS` の 15分

いずれも**測って決めたものではない。** 見た目で決めた。
実際に使ってから直すこと。コード側にもその旨のコメントがある。

## 2026-09-03 /api/quotas は上流を叩かなくなった

**429 は待っても戻らなかった。自分で制限を維持していたためである。**

    最終成功 73分前 / 連続失敗 14（= 73分 ÷ 5分。収集の回数と一致）

つまり 14 は**ハブ自身の収集だけの数**であり、
ウィジェットが毎分投げていた分は**どこにも数えられずに**上流を叩いていた。

    /api/quotas が毎リクエスト queryAllQuotas() を実行していた
    updateTray() と buildPayload() が別々に叩く = 1台で毎分2回
    それを台数分に増やしたのが 2026-09-02 の変更だった

直したこと:

    サーバ  /api/quotas は quota_current から返す（quotasFromStore）
            上流へ行くのは収集と POST /api/quotas/refresh だけ
    ウィジェット  refreshAll() が1回読み、トレイとパネルの両方に配る
            タイマーも1本にした（トレイ5分・パネル任意 → 短い方1本）

実測（本番に触れずに、隔離した AIUSAGE_HOME で）:

    資格情報を1つも置かない config で serve を起動し、本番DBの複製を読ませた
    → claude-code の実数が返る（five_hour=11% seven_day=9%）
    **資格情報が無いのだから、生クエリでは絶対に出ない値である**
    → 10連続リクエストの所要 1.3〜1.6ms（ネットワーク往復ではない）
    → stale=true / consecutiveErrors=16 も保存値から正しく出る

ウィジェット側（計数プロキシ経由・30秒間隔で75秒）:

    /api/quotas の増分 15秒ごとに +1, +0, +1
    = **1ティックあたり1回。** 以前は同じティックで2回だった

テストにも約束として書いた:
`expect(vi.mocked(queryAllQuotas)).not.toHaveBeenCalled()`

**stale の意味を意図的に変えた。**
以前は「生クエリが失敗したので保存値を出す」、
いまは「直近の収集が失敗したので、本来より古い」。
どちらも表示が答えるべき問い ──「目の前の数字を信じてよいか」── に答えている。

## 2026-09-03 分類 (c) の直接原因を塞いだ

`readConfigFile()` を1つ作り、**「ファイルが無い」と「あるのに読めない」を分けた。**
後者は投げる。既定に落ちない。

    ウィジェット  起動時に捕まえて、窓の最上段に赤字で出す
                  configProblem として WidgetUpdate に載せた（型で強制）
                  **窓は開く。** ハブのアドレスを手で入れれば回避できる
    CLI          loadConfig() は null のままだが、**1度だけ警告を出す**
                 （数十の呼び出し元が「設定なし」を通常として扱うため）

**BOM を名指しする。** 先頭が U+FEFF なら
「Set-Content -Encoding UTF8 ではなく [System.IO.File]::WriteAllText を使え」
と出す。エディタでは見えないので、これが最も役に立つ。

ついでに見つかった同じ穴:
`credentials.ts` の `readConfig()` は parse 失敗で `{}` を返し、
**`saveCredential()` はその `{}` を書き戻していた。**
「上書きすると webhook を失う」とコメントに書いてある処理が、
まさにそれをしていた。もう投げるので起きない。

## 2026-09-03 二重起動は OS のロックで防ぐ

`app.requestSingleInstanceLock()` をウィジェット本体に入れた。
2つ目は即座に終了し、既存の窓を前に出す。

pid ファイルの穴は2つだった:
**CLI の launchWidget を通らない起動には効かない**（ショートカット・直接起動）。
**ファイルが消えると何も見張らない**（クラッシュ後の通常の姿である）。

実測: 起動中にもう1度起動 → プロセス数 4 のまま変化なし。

## 2026-09-03 画面が既定値を見せていた（(c) の表示版）

職場PCの設定パネルの実物。**窓は正しくハブを読んでいた**
（Claude が出ており、ハブの数字と一致）。**パネルの表示だけが違っていた。**

    アドレス  [ http://127.0.0.1:3847 ]  ← 常にこの文字列のプレースホルダ
    パスワード [                      ]  ← 保存済みでも空

どちらも**内部の状態ではなく既定値を見せていた。**
動いてはいるので誰も気づかない。分類 (c) の表示版である。

**アドレスの方は実害があった。** 前日、この端末が 127.0.0.1 を読んでいると
誤って疑った ── そして実際にそうだった時期もある（BOM の件）。
**正しく動いている端末と、壊れている端末が、同じ画面になっていた。**

直したこと:

    アドレス    プレースホルダを resolveHubUrl() の結果にした
                （＝ WidgetUpdate.hubUrl。窓が実際に読んでいる先そのもの）
                「空欄なら自動 ── いまは <アドレス>」を下に添えた
    パスワード  hubPasswordSource() が 3状態を返す
                typed     … この端末で保存した   → 「保存済み」
                inherited … ハブ自身なので自分の … → 「この端末のものを使用中」
                none      … 無い                 → 従来の「入れてください」

**inherited を typed に畳まなかった。** ハブでは何も入力していない。
「保存済み」と言うのは、逆向きの、同じ種類の自信のある嘘である。

**値は返さない。** 状態だけを返す IPC を1本足した。

実測（自宅PC＝ハブ、こちらが正しい方）:
プレースホルダ `http://127.0.0.1:3847`、
「空欄なら自動 ── いまは http://127.0.0.1:3847」、
「ダッシュボードのパスワード — この端末のものを使用中」。

spoke 側（tailnet のアドレス＋「保存済み」）は**この端末では再現できない**ので、
`resolveHubUrl()` の優先順位を単体テストにした（7件）:
入力＞`hubForward.url`＞`127.0.0.1:<.serve-port>`、
BOM 付き config では投げること、入力があれば壊れた config でも答えること。

## 2026-09-03 見張り役が5分ごとに画面を奪っていた

利用者から「数分おきに黒い窓が出て、入力が中断される」。

    <Repetition><Interval>PT5M</Interval></Repetition>
    <Command>cmd.exe</Command>
    <LogonType>InteractiveToken</LogonType>

`LogonType Interactive` のタスクは**ログオン中のセッションで動く。**
`cmd.exe` を指していたので、5分ごとにコンソール窓が前面に出ていた。
**serve が生きていても出る** ── 生死を確かめる処理そのものが実行だからである。

    serve が落ちた回数   14時間で3回
    窓が出た回数         168回

`wscript.exe` ＋ 1行の VBS（`intWindowStyle 0`）に変えた。
**見張りは残す。間隔も変えない。** 戻す役目は要る。

実測: 7秒かかる .cmd を VBS 経由で起動 → 子プロセスは動いており、
**可視のコンソール窓は0。**

VBS は **ASCII で書く**。WSH はコンソールコードページで読むので、
**BOM は1行目の構文エラーになる。**
`Set-Content -Encoding UTF8` は BOM を付ける ── 今日の config.json と同じ罠を
別のファイルでもう一度踏むところだった。生成後に先頭3バイトを確認済み。

### 指示の前提について1点

「`scripts\write-update-cmd.ps1` が作るタスク」とあったが、
**この script はタスクを作っていない。** 作っているのは更新用の3本だけで、
タスクの登録は SETUP-NEW-MACHINE.md の手順8（管理者権限が要る）である。
VBS の生成をこの script に足し、タスク側の記述は手順8と 8-b に書いた。

差し替えは **`Set-ScheduledTask -Action` のみ**。
実測: 管理者権限は不要、プリンシパル（Interactive）もトリガも保持される。
`Unregister` → `Register` にすると S4U 拒否をもう一度踏む。

## 2026-09-03 折りたたみ（帯）

× とは別に「消さずに小さくする」状態を足した。

    開いた状態  309 x 212
    畳んだ状態  250 x 64   （2ツール・メーターのみ）

**見積りは約48だった。実測は64。** 差はほぼ `.section` の余白と枠で、
帯そのものの行は見積りどおり。**見積りを実測に置き換えて記録する。**

### 帯に出すもの

1ツール1行、名前＋メーター2本。割合も残り時間も出さない
（畳んでいる間は `quotaDetail` を 'meter' 扱い）。
「5時間／週」の文字も出さず、**位置で表す**（左=5時間・右=週）。
順序は `KIND_ORDER` で並べ直す ── **位置が意味なので、
届いた順に描くと黙って逆のことを言う。**

### ★ 経路を2本にしなかった

**畳んだ用の描画を書いていない。** 畳むと消えるのはヘッダと
設定パネルと旧セクションだけで、
config が読めない／ブリッジが無い／ハブに繋がらない／まだ値が無い／
◯分前の値、は**すべて同じ `{#if}` がそのまま描く。**

窓は内容に合わせて伸びるので、**帯に収まらないものは帯が広がる。**
特別扱いを書いていない ＝ 書き忘れる場所が無い。

`tests/collapse.test.ts` がこれを固定する（5件）:
メッセージ群が collapsed の分岐の中に無いこと、
畳みが隠してよいものの一覧、利用枠セクション自体は無条件であること。

**実測: 畳んだままハブを落とす**（使い捨て serve をポート3998で起動して kill）
→ 帯が「ハブに繋がりません（http://127.0.0.1:3998）。」に変わった。読める。

### ★ 床は状態ごとに、しかも「送る」形にした

`MIN_WINDOW_HEIGHT = 120` を廃し、`PanelSize.minHeight` として
**計測値と同じメッセージで送る。**

    開いているとき  120
    畳んでいるとき  帯1行 + 帯の padding を **DOM から実測して**返す

main に定数を2つ置くと「いまどちらの状態か」を main も持つことになり、
片方だけ更新される瞬間に**間違った床で静かにクランプされる。**
今日の4回と同じ形なので、そうしなかった。
main 側に残したのは 16〜400 の正気度チェックだけで、これは床ではない。

### ★ 掴む場所と押す場所が同じ問題

ヘッダを消すと `-webkit-app-region: drag` も消える。
だが drag 領域は**クリックをページに返さない**ので、
帯に drag を付けると「動かせるが開けない」になる。

**JS でドラッグを実装した。** 押して動かなければ開く、
動けば窓が動く（しきい値4px）。**小さいボタンは置いていない。**
帯全体がどちらの操作の的でもある。

実測:
  ・押して -120,-60 動かす → 窓がちょうど -120,-60 移動、畳んだまま
  ・押して離すだけ → 250x64 → 309x212 に開き、設定にも false が保存された
  ・右下角は保たれる（右端 1773 → 1773、下端 969 → 968）

### そのほか

  ・畳んでいる間は blur で隠さない。常在するものが
    他所をクリックした瞬間に消えるなら、それは常在ではない
    （今は packaged ビルドでしか発火しないが、
     それは起動方法の性質であって、誰かが折りたたみについて下した判断ではない）
  ・× はホバーで赤くなる。▾ は無彩色のまま。押す直前に差が見える
  ・通知は `checkNotifications()` のままで**一行も変えていない**（差分で確認）

## ★ 3台で確かめられない挙動 ── 未走行が1つ、代用が1つ

3台とも `aiusage widget` からチェックアウトのビルドを起動しているので
`app.isPackaged` は**常に false** である。
そのため `isPackaged` で分かれる挙動は、**片側しか動いたことがない。**

**これは欠陥ではない。誰も packaged を使っていない。いま塞ぐ必要もない。**
書いておくのは、**packaged を作る日が来たとき、最初に見る場所がここだから**である。

今日わかったことは、結局ぜんぶ
**「動かしていない経路に欠陥が住む」**の一形だった。
不完全な payload の失敗経路、サンドボックスの preload、
`widget:get-data` の null、BOM で既定に落ちる `configuredHubUrl()`
── どれも「そこを通ったことがなかった」。
ここは**そうと分かっている区間**なので、名前を付けて置いておく。
ただし2つは**種類が違う。** 片方は通っていないだけで、
もう片方は**通っていて、正しく見えていて、違う問いに答えている。**

### 種類が違う。1つは未走行、もう1つは代用である

    shouldHideWindowOnBlur(isPackaged) → isPackaged     ── 未走行
      packaged のときだけ true。**3台では一度も発火していない。**
      packaged にすると「窓が他所をクリックした瞬間に消える」が
      初めて動きだす。折りたたみ側だけは 2026-09-03 に塞いだ
      （畳んでいる間は隠さない）が、**開いているときの挙動は
      いまだに誰も見ていない。**
      これは**動かせば分かる。** 動かしていないだけである。

    shouldShowWindowOnLaunch(isPackaged) → !isPackaged  ── ★ 代用

**こちらは未走行ではない。答えたい問いと違う問いに答えている。**

答えたいのはおそらく

    「自動起動で立ち上がったのか、人が起動したのか」

で、`isPackaged` はそれを**何も語らない。**
packaged を**手で起動しても窓は出ない。** 人が起動したのに出ない。
初回に何も出ないのは、この代用の副作用にすぎない。

副作用のほうも書いておく（こちらは実害の見積りである）:
**packaged にすると正常起動で窓が出ない。**
手がかりはトレイのアイコンだけになるが、
**Windows 11 は既定でトレイアイコンを隠す**（2026-09-02 に実測）。
**packaged の初回起動は、画面上に何も出ない可能性がある。**
401 と config 破損の経路は窓を強制的に出すので、そこは通る。
通らないのは**正常起動**である。

**分類 (c) である。** 動かしても正しく見える ──
開発ビルドでは「人が起動した」と「packaged でない」がたまたま一致するので、
3台のどこでも症状が出ない。**未走行の分岐なら動かせば分かるが、
代用は動かしても分からない。** だから (c) は毎回いちばん遅く見つかる。

直す方向（**いま作らない。自動起動の仕組み自体がまだ無い**）:

    自動起動の登録側が --autostart のような印を付け、それで判断する
    packaged かどうかは無関係にする

      人が起動した → 出す（packaged でも）
      自動起動     → 出さない（開発ビルドでも）

`shouldHideWindowOnClose` は引数を無視して常に true なので、
未走行の分岐も代用も無い。

### 単体テストがあることは、通ったことの証明ではない

`tests/ui.test.ts` は3つとも両方の入力を検査していて、通っている。
**関数は検査済みで、その関数が制御する挙動は一度も動いていない。**
今日の4回はすべてこの隙間で起きた ── 型も単体テストも正しく、
組み上がった経路を誰も通っていなかった。

### packaged を作る日にやること

  1. **起動して窓が出るか**を最初に見る（出ない設計になっている）
  2. 窓を出してから他所をクリックし、消えてよいのか判断する
  3. トレイアイコンが既定で隠れることを前提に、
     初回だけは窓を出す形が要るか決める

## ★ 常に間違う警告（2件）

**常に間違う警告は、警告を読まない習慣を作る。**
本物が来た日、同じ文言・同じ色の中に埋もれる。
だから消すのではなく、**間違う理由を書いて黙らせる。**
次に触る人が「なぜ無視してよいのか」を自分で判断できる形にする。

いま2件ある。**同じ種類である。**
どちらも「検査が、実際の条件を評価できていない」。

### 1. svelte の a11y 警告 ── 2026-09-03 に黙らせた

    A11y: noninteractive element cannot have nonnegative tabIndex value
    App.svelte  role={collapsed ? 'button' : undefined}

**コードは正しい。** `role` `tabindex` `on:keydown` は**同じ `collapsed`**
で切り替わる。畳んでいれば role="button"・タブ順に入る・
Enter / Space でクリックと同じく開く。開いていれば3つとも付かない。
**片方だけが適用される状態が存在しない。**

svelte-check は属性を静的に評価するので、
**`collapsed` を評価できず、見えないペアリングを「無い」と報告する。**
検査の限界であって、markup の穴ではない。

`<!-- svelte-ignore a11y-no-noninteractive-tabindex -->` に
理由を添えて黙らせた。ビルドの警告は0になった。

### 2. ノートPCの `no parse` 警告 ── 未対処（今日は直さない）

    [settings-controller] no parse has completed for 282 minute(s);
    the interval is N minute(s)

`checkParseHealth()` は「最後に成功した parse からの経過」だけを見る。
**ノートPCは眠る。眠っている間も経過時間は進む。**
だから**眠るたびに必ず出る。** 異常ではない。

**これも「検査が実際の条件を評価できていない」である**
── 1 は `collapsed` を、2 は「その時間、機械が動いていたか」を見ていない。

**直し方は決まっている。観測は要らない ── 眠りは直接わかる。**

はじめは「ノートPCが1日に何回眠るか見てから決める」としていた。
**それは要らなかった。** 経過時間を見るから観測が要るのであって、
**刻みの間隔を見れば眠りはその場で分かる。**

    停止判定そのものが一定間隔のタイマーで動いている。
    連続する2回の発火が5分ではなく200分空いていたなら、
    **その195分、機械は動いていない。**

動いている機械の刻みは間隔どおりに並ぶ。**並ばなかった区間が眠りである。**

    → 前回の発火時刻を1つ持ち、間隔から飛んだぶんを差し引く

これで (a)(b) の選択も決まる。**(a)**。
差し引く対象が「観測して決めた見積り」ではなく
**実際に飛んだ区間**になるので、(b) の猶予のような当て推量が要らない。

**2026-09-03 に実装した**（この下の節を見ること）。放置ではなかった ──
放置すると 1 を黙らせた意味がこの1件で相殺される。

### 判断の基準

**「出るのが正しいか」で決める。**
出るのが正しくない警告だけを黙らせる。
出るのが正しい警告（本当に parse が止まっている）は、
黙らせずに**出ない条件のほうを直す。**

## 2026-09-03 `no parse` を稼働時間で測るようにした

### ★ 境目を決めずに済む形があるなら、そちらを選ぶ

**根拠の無い数字は、増やさないほうが後で困らない。**

素直に書けば「間隔が◯倍を超えたら眠っていたとみなす」になる。
だが**その◯には根拠が無い。** 今日 70 / 90 / 15分 について
「測って決めた数字ではない」と書いたばかりで、**4つ目**を足すところだった。

採った形:

    毎回の発火で加算するのは  min(実際の間隔, 想定の間隔)

    5分の予定が5分で来た    → 5分を足す
    5分の予定が6分で来た    → 5分を足す（揺れは自然に無視される）
    5分の予定が200分空いた  → **5分だけ足す**（195分は足されない）

**眠りを判定していない。** 眠りは「足されなかった時間」として自然に落ちる。
**どこにも境目が無いので、決める数字が増えない。**

これは他所にも持っていける形である。
**「検出する」より「そもそも数えない」ほうが、しきい値を要求しない。**

### 実装

    ParseHealth.runningMsSinceParse   稼働時間。壁時計ではない
    lastHealthCheckAt                 前回の発火時刻（メモリのみ）
    停止判定                          runningMsSinceParse > thresholdMs

累積は解析成功でゼロに戻る。serve 再起動で消える。
**再起動直後に警告が出ないのは正しい** ── まだ動いていない時間が無いため。

### 文言 ── N が壁時計でなくなることを、読む人に伝える

    旧  no parse has completed for N minute(s)
    新  no parse has completed in N minute(s) of running time
        (sleep is not counted); the interval is M minute(s)

4時間閉じていたノートPCで「21分」と出たとき、
**それが誤りではないと読めること**が要件だった。

**通知本文も同じ数に直した。** 電話に届くのは同じ一文なので、
片方だけ直すと**もう片方が古いことを言い続ける** ── 今日ずっと潰してきた形である。

    稼働中の N 分間、解析が1度も完了していません（スリープ時間は除く）。

### 実測（テスト42件・うち新規4件）

    稼働中は壁時計と一致する          7分回して runningMs = 7分ちょうど
    途中で長く空けても跳ねない        10分回す → 4時間ジャンプ → 11分のまま
                                      （足されたのは目覚めを検知した1分だけ）
    本当に止まったときは従来どおり出る 4時間ジャンプの後に20分回す → 1回だけ通知
    文言が壁時計でないと分かる        'of running time' を含み '240' を含まない

**3番目が消えたら意味が無い**ので、独立したテストにした。

既存の停止判定テストも書き換えた。旧テストは
「時計を進めてからタイマーを追いつかせる」形だったが、
**それは処理系から見ると眠りそのものである。**
`runFor()` を足して、時計とタイマーを1分ずつ揃えて進める形にした
（＝稼働）。ジャンプさせる形は眠りのテストとして残した。

## 2026-09-03 帯にも数字を出した（先の「メーターだけ」を取り消し）

**メーターは「だいたい」しか言わない。** 62 と 68 の区別が付かない。
上限が気になっているのだから、**何％かが読めなければ帯の意味が薄い。**

    畳んでいる間の detail  'meter' → 'percent'
    残り時間               出さない（長く、上限の話でもない）
    5時間 / 週のラベル     出さない（位置のまま）

`'percent'` は既存の詳細度をそのまま使っている。
**帯のための3つ目の描画を作らない** ── 開いているときと同じ絵で、
同じ意味であることが保たれる。

### ★ 数字が動いても行が揺れない

割合は毎分変わる。**2つ目のメーターは1つ目の数字の後ろに置かれる**ので、
幅が変わると横に押される。目の端に置くものが揺れるのは最悪である。

    .strip-pct  min-width 2.5rem（"100%" の幅）
                text-align right
                font-variant-numeric: tabular-nums

**実測（6% / 62% / 100% の3枚を画素で比較）:**

    メーター1  75-152    3枚とも同一
    メーター2  207-284   3枚とも同一
    窓の幅     342 x 64  3枚とも同一

差が出たのは数字のグリフの区間だけで、
**右寄せの固定枠の中で左へ伸びるので、メーターは1画素も動かない。**

### 実測（そのほか）

    畳んだ状態    250 x 64 → **342 x 64**（幅は伸びた、**高さは不変**）
    ハブを落とす  261 x 64「ハブに繋がりません（…）。」── 経路は不変

「幅は広げてよい。高さが小さいことが帯の目的である」という判断どおり。
**目盛りを減らして詰める案は採らない** ──
開いているときと畳んでいるときで同じ絵の意味が変わる。

### ★ 途中で、自分の測定が1時間ぶん嘘だった

数字を足したのに実測がずっと `250 x 64` のままだった。
原因は**古いウィジェットのプロセスが生き残っていたこと。**

    Stop-Process    → アクセスが拒否されました
    taskkill /F /T  → アクセスが拒否されました
    Invoke-CimMethod -MethodName Terminate → **成功（0）**

そのプロセスが**単一インスタンスのロックを握っていた**ので、
新しく起動したものは即座に終了していた。
**「起動した」と「新しい版が動いている」は別のことである。**

さらに `Get-Process electron` には
**ExecutablePath も所有者も読めない項目が2つ**混ざっていた。
プロセス数だけで数えると、その2つを自分のものと数えてしまう。
**数えるなら ExecutablePath で絞ること。**

窓が別のアプリの吹き出しに隠れていて、
`SetForegroundWindow` が拒否されたまま**別のウィンドウを撮っていた**回もあった。
**撮れた画像が目的のものかを、毎回見ること。**

## 2026-09-03 掴みが外れない ── 要素に張ると、外で離した音が届かない

### 症状

素早く大きく掴んで動かすと、掴みが外れないことがある。

### 原因

`mousedown` / `mousemove` / `mouseup` を**帯の要素に張っていた。**
帯は 342 x 64 しかないので、**速く動かすとカーソルが窓の外へ出る。**
出たあとは要素に何も届かない ── 移動も、**ボタンを離したことも。**

    離した音が届かない → 掴んだ状態が残る
    カーソルが帯の外にいる間は、移動も届かないので窓は動かない
    **カーソルが帯へ戻った瞬間に、また付いてくる**

### 実測（同じ操作を、直す前と後で）

    速く掴んで外へ投げ、外で離す。そのあと帯の上へ戻して、押さずに動かす。

    直す前  ドラッグ中に窓が**1度も動かない**（1歩目で外へ出るため）
            そのあとの**ただの押下で帯が開かない** ← 残った掴みが食べている
    直した後 窓は**ドラッグ全量に追随**（-720,-480）
            押さずに動かしても付いてこない
            ただの押下で 342x64 → 309x212 に開く

**「速いと効かない」と「掴みが残る」は同じ1つの原因だった。**

### 直し方

`mousedown` の時点で **`window` に move / up を張り、up で外す。**
窓の外で離しても、窓は必ずそれを聞く。
`blur` でも解除する（alt-tab でボタンを持っていかれる経路）。
コンポーネント破棄でも解除する。

4px のしきい値はそのまま。報告どおり動いている。

## 2026-09-03 背面へ回せるようにした（透過は作らない）

「右下で他の窓に被る」への答えとして、**背面へ回すほうだけを作った。**
透過は「読めるが薄い」という中途半端な状態を1つ増やすので、
**背面で足りないと分かってから。**

    設定 alwaysOnTop（既定 true）
    導線 設定パネルの「常に最前面」と、**トレイの右クリックメニュー**

**トレイ側が本命である。** 窓が何かの背面に回ったら、
その窓の設定パネルも背面にある。**常に届くのはトレイだけ。**

戻し方はトレイの「パネルを表示」。これは従来どおり窓を前へ出す。

### 実測（1つのプロセス内で通した ── 途中で窓を見失わないため）

    起動直後        309x212  WS_EX_TOPMOST=True
    設定を開く      342x975  True
    トグルを押す    342x975  **False**   ← その場で外れる
    設定ファイル    alwaysOnTop: false
    再起動          309x212  **False**   ← 記憶している

### ★ 測定を邪魔していたのは自分の測定器だった

最初、押しても `topmost=True` のままに見えた。
**窓を空いた場所へ寄せる自作のヘルパが `HWND_TOPMOST` で寄せていた**ためで、
押した直後に自分でビットを立て直していた。`HWND_TOP` に変えて解決。

**測る道具が、測る対象を変えていないかを見ること。**
（同種のことが今日もう1件あった ── 撮った画像が別のウィンドウだった件）

## 2026-09-04 拡大率の下限を 0.7 → 0.5 に下げた ── そして 64 という床が出てきた

### 下限の根拠を書き換えた

    旧  0.7 未満では、腕を伸ばした距離で％が読めなくなる
    新  帯を「押す・掴む」ことができる限界。読めるかは利用者の判断

利用者が「文字が小さくていい」と言った時点で旧の根拠は外れた。
根拠が外れた値は残す理由が無い。帯用と開いた用で**拡大率は分けていない**。

### ★ 指示の算術は成り立たなかった ── Windows の透過窓は 64px より低くならない

指示は「0.5 で帯は 342×64 → 約171×32」だったが、**実測は 172×64**。
幅は半分になり、**高さは 64 のまま**だった。

    main が setBounds に渡した高さ   33
    Electron の getBounds / contentSize  33   ← Electron はそう信じている
    OS の GetWindowRect                 64   ← 実際の窓
    DPI                                 100%

`transparent: false` にして同じ操作 → 要求 39・実測 39。**一致する。**
つまり **透過（レイヤード）窓を Windows は 64 device px より低くしない。**
幅にこの床は無い（100 幅は通った）。コード上に最小サイズの指定は無く、
`setMinimumSize(1,1)` を強制しても変わらなかった。

**zoom 1.0 の帯はちょうど 64 だった。** だから今まで見えなかった。
偶然、床の上に乗っていた。

### 見えない床が何を壊すか

Electron の描画領域（viewport）は自分が要求した 33 のまま、
窓だけ OS が 64 にする。**下の 31px は描画もされず、クリックも届かない。**
帯の真ん中（y=32）を押すと**境界ぎりぎりで開いたり開かなかったりした。**
── 押せることが下限の理由なのに、押せない領域が半分あった。

### 直したこと

    main    TRANSPARENT_MIN_HEIGHT_WIN = 64 を win32 のとき nextHeight の下限に
            **選んだ数字ではない。OS が既に適用している数字を書き写した**
            ── 書くのは、Electron の窓の認識を実物と一致させるため
    renderer  #app:has(.content.collapsed) で帯を窓の中央に置く
            body の mousedown で、帯の周りの空きも押下の的にする
            .panel 自身の計測は変えていない（メッセージで伸縮する経路は不変）

**中央寄せの1回目は効かなかった。** body にクラスを付ける方式で、
CSS はバンドルに入っていたのにクラスが当たっていなかった
（「畳んでいるか」の写しをもう1つ作った形）。`:has()` に変えて写しを無くした。

### 実測

    zoom 0.5  帯 172 x 64   幅は半分、高さは OS の床
              掴んで動かす → -270,-180 移動、押さずに動かしても付いてこない
              真ん中を押す → 開く（156 x 106 = 212 × 0.5）
              **y+50（旧・死んでいた領域）を押す → 開く**
              画像: 帯が窓の縦中央に来ている
    zoom 0.7  241 x 64
    zoom 1.5  515 x 96
    zoom 0.3  171 x 64  （0.5 に丸められる）
    zoom 1.0  342 x 64  （不変）

**0.7〜1.5 で変わったこと**: 畳んだ帯が 64 より低い場合（zoom < 1.0）だけ、
上寄せ＋空きだった帯が中央に来る。1.0 以上は何も変わっていない。

### 決めていないこと（指示役の判断）

**64 より低い帯は、透過を捨てない限り作れない。**
`transparent: false` なら要求どおりの高さになる（実測 39）が、
角丸と背景の透過を失う。**見た目の話なので実装側では決めていない。**

### 記録として

「境目を決めずに済む形があるなら、そちらを選ぶ」は保っている。
64 は境目ではなく、**測定で出てきた OS の事実**である。
書いたのは「Electron の認識と窓の実物がずれる」のを止めるためで、
この数字が別の Windows・別の DPI で違えば、症状は
「帯の下に空きがある」として現れる。その時に測り直す場所がここ。

## 2026-09-04 大きさを4段階にした（拡大率の目盛りを置き換え）

    普通    zoom 1.0   詳しさは設定どおり
    小      zoom 0.8   同上
    極小    zoom 0.65  同上
    最極小  zoom 0.5   **数字だけ**（'number'。メーターを描かない）

利用者の言葉のまま4段。各段は (拡大率, 詳しさ) の**固定の組み合わせ**で、
選ぶのは1つだけ。0.1刻みの拡大率とトレイの拡大／縮小は消した。
大きさを決める操作が2つあると「なぜ今この大きさなのか」が分からなくなる。

`size.ts` が唯一の表。main（zoom）・renderer（detail）・設定パネル・トレイが
全部ここを読む。`zoomFactor` を持つ古い設定ファイルは**初回だけ一番近い段へ写し、
以後は書き戻さない**（実機のファイルで確認: 起動後に zoomFactor が消えた）。

### ★ 透過を切った ── そして、思っていた見た目にはならなかった

透過窓は Windows が高さ 64 より低くしない。極小・最極小は透過があると作れない。
利用者が透過を後回しにしたので `transparent: false` にした。

**切り替え設定は作らない。** `transparent` は窓の生成時にしか決まらず、
切り替えには窓の作り直しが要る。滅多に通らない経路は、写し忘れた状態が住む場所になる。
欲しくなったら「再起動が要る」と言う設定にすること。この1行はコードにも残した。

**角丸は消えなかった。影も消えなかった。** Windows 11 は不透明なトップレベル窓の
角を自分で丸め、影も自分で描く。CSS の border-radius は 0 にしたが、
実物の窓は角が丸く、縁に影がある（実測・画像あり）。
「普通の開いた窓が四角くなる」という事前の見込みは**この環境では外れた**。
Windows 10 や他の OS では四角くなる可能性がある ── そこは未測。

### 床は 64 → 39

透過なしでも枠なし窓は **39 device px** より低くならない
（要求 12 でも 33 でも 39。thickFrame:false でも同じ）。
`FRAMELESS_MIN_HEIGHT_WIN = 39` に書き換えた。選んだ数字ではなく OS の実測値。

### 最極小がメーターを消す理由

提案の下2段は 42 と 39 で 3px しか違わず、段として成立していなかった。
最極小は拡大率を下げるのではなく**メーターを消す**。0.5 ではメーターのほうが
先に読めなくなり、数字だけのほうが同じ面積でまだ読める。
'number' は `quotaDetail` の軸に足した1値で、**同じ `{#each}` がバーを描かないだけ**。
行の構造もメッセージの `{#if}` も変わっていない。設定パネルの詳しさボタンは
最極小のとき灰色にして「最極小では数字だけになります。」を添えた
── 効かない設定を選べる画面は (c) の表示版なので。

### 実測（畳んだ帯）

    段       見込み      実測
    普通     342 × 64    342 × 63
    小       274 × 52    274 × 51
    極小     222 × 42    223 × 42
    最極小    ~87 × 39   **100 × 39**

見込みとの差は 1px 以内、最極小だけ幅が 13px 広い
（名前の min-width 3.5rem を数字の列幅で数え落としていた）。

    最極小  掴む → -360,-240 移動、押さずに動かしても付いてこない
            押す → 開く（128 × 106・数字だけ）
            ハブを落とす → 134 × 39 に広がり「ハブに繋がりません（…）。」が読める
    普通    開いた窓 309 × 212（変更前と同一）

### 途中で出た、自分の設定の食い違い

普通の開いた窓が 254 幅で出て「壊した」と思ったが、
設定ファイルの `quotaDetail` が `'meter'` だった ── 昨日、座標だけで
盲目にクリックしていた回のどれかが「メーターだけ」を押していた。
**表示は正しく、設定が思っていたものと違っていた。**
`full` に戻すと 309 × 212。座標だけで押す検証は、押した結果を毎回読むこと。

    段を変えて再起動  設定パネルで「小」→ ファイル size=small → 再起動 → 247 × 168（309×0.8, 212×0.8）→ そのまま

## 2026-09-04 ツール名を印にした（全段に置き、最極小で文字だけ消す）

    Claude   ● 暖色（琥珀）
    Codex    ■ 寒色（青）
    Copilot  ◆ 紫（3つ目のツールが来ても印なしにならないため）
    不明     ● 灰（--text-muted）

**公式ロゴは使わない。** 公開リポジトリに商標を置くことになる。
色は既存のチャート色と同じ値だが、**独自のトークン `--mark-*`** にした
── チャートの系列を塗り替えたときにツールの名前まで変わってはいけない。

**印は全段で同じ要素。** 普通〜極小は「● Claude」、最極小は「●」だけ
（名前の `<span>` は `sr-only` で視覚だけ消え、読み上げには残る）。
普通サイズで毎日「●＝Claude」を見ているから、最極小で印だけになっても迷わない。
最極小だけに出す印は、初めて見る印になり「どちらがどちら」を持ち込む。
順序（Claude 上・Codex 下）は固定のまま。色が読めなくても位置が残る。

### コントラスト（OKLCH の値から計算・WCAG 図形は 3:1 以上）

    Claude ● 琥珀   ライト 2.62:1 ← **不合格** → oklch(0.66 0.12 65) に下げて 3.07:1
                     ダーク 6.88:1（値はそのまま）
    Codex  ■ 青     ライト 3.78:1   ダーク 4.76:1
    Copilot ◆ 紫    ライト 4.05:1   ダーク 4.45:1

ライトとダークで `--mark-claude` の値が違う唯一の印になった。
サンプリングではなく OKLCH → 線形 sRGB → 相対輝度で計算した。

### ★ 最極小の幅を止めていたのは名前列ではなかった

印にしても最極小は **100 × 39 のまま**だった。
原因は `.panel { min-width: 200px }` ── zoom 0.5 でちょうど 100 device px。
**前回「名前列 3.5rem を数え落とした」と書いた 87 → 100 の差も、実はこれだった。**
名前を消しても幅が変わらないことで初めて見えた。
畳んでいるときはこの床を外した（開いたときはヘッダが 224 あるので影響なし）。

### 実測

    最極小   見込み ~65 × 39   実測 **65 × 39**（100 から 35px 減）
    極小     223 × 42  小 274 × 51  普通 343 × 63  （不変）
    普通の開いた窓  309 × 212（不変）。「● Claude」「■ Codex」が名前の左に並ぶ
    ライト／ダーク  両方の画像で印が背景から浮いている

メッセージの `{#if}` には触れていない（diff で確認）。

## 2026-09-04 自動起動 ── 先に「届かなければ終了」をやめた

利用者から「PC を再起動したらウィジェットが出なくなった」。自動起動が無かった。
だが順番がある。**自動起動は serve と同時に走る。** serve が listen する前に
ウィジェットがハブへ行けば unreachable で終了する ── 毎回、静かに。
利用者には「出ない」としか見えない。今週3度目の「静かに居ない」形。

### 1. 起動時のハブ失敗は、何であれ起動する

    unreachable / unexpected  起動して、覚えている形（帯 or 窓）に
                              「ハブに繋がりません（…）」を出し、更新間隔で聞き直す
    401                       起動して設定パネルを開く（先日どおり）

繋がった次の更新で数字に変わる。**再起動なし・起動経路は1本。**
先日の `--autostart` 印（代用の件）は**これで不要になった** ──
「届くまで待つ」が、自動起動も手動起動もログオン直後も全部覆う。

実測（使い捨てハブ 3998・本番は不使用）:

    ハブ停止のまま起動  帯 261 × 45「ハブに繋がりません（http://127.0.0.1:3998）。」
                        ログ: cannot reach … - starting anyway and retrying every 30s
    ハブを起動 t=0      t=7s 261×45 → t=13s 261×45 → **t=20s 343×63（数字）**
                        更新間隔 30s の1ティック以内。再起動なし

### 2. 自動起動 ── serve とは別のタスク

`scripts\write-update-cmd.ps1` が `start-widget.cmd` と `start-widget-hidden.vbs` を書く
（ASCII・BOM なし、確認済み）。`node <絶対パス>\index.js widget` で起動する
── タスクの PATH に `aiusage` は無い。CLI は Electron を切り離して数秒で終わる。

serve のタスクに相乗りしない: serve は5分ごとの見張り付き、ウィジェットは1度きり。
5分ごとに起動されるウィジェットは単一インスタンスのロックに毎回追い返されるだけ。
登録と差し替え（`Set-ScheduledTask`）は SETUP-NEW-MACHINE.md 11-5b。

**PC 再起動 → ログオン後に手を触れずに帯が出ること、だけは利用者の実測待ち。**
こちらでは再起動できない。

### 3. ★ `widget.pid` は証拠にならない ── 判定を外した

`isWidgetRunning()` は `widget.pid` の pid を `process.kill(pid, 0)` で見ていた。
調べると、**そのファイルを書く側がもう無い**（CLI が読むだけ）。
さらに再起動後は同じ pid を別プロセスが持ちうるので、
「既に動いている」と誤判定して自動起動が静かに何もしない ── 必要なその瞬間に。

「本当にこのウィジェットか」を確かめる材料が無いので、**信じない＝判定を外す。**
二重起動は OS の単一インスタンスロックが止める（2つ目は即終了して既存の窓を前に出す）。

実測: explorer.exe の生きた pid を `widget.pid` に書いて `aiusage widget`
→ 「started from this checkout」→ 窓 343 × 63。

### 検証で踏んだこと（今日の分）

  ・スクラッチの補助スクリプトが、10時間の空白の間に**消えていた**（一時領域の掃除）。
    出力を `size:` 行だけに絞っていたので「スクリプトが無い」が「窓が無い」に見えた。
    **フィルタは失敗の形も通すこと。** 以降は `grep -v "^True$"` だけにした
  ・Windows の**スタートメニューが帯の右半分に被っていた**回があり、
    帯が途中で切れて見えた。余白付きで撮って初めて分かった。
    **切れて見えたら、まず何が上に載っているかを撮る。**

## 2026-09-04 「常に最前面」の既定を false に

利用者の要望で既定を外した。**移行は作らない。**

★ **既定値は保存時にファイルへ書き込まれるので、既定を変えても既存の端末には効かない。**
3台の設定ファイルには（利用者が選んだのではなく他の設定を保存したときに）
`alwaysOnTop: true` が入っており、ファイル上で「既定で書かれた true」と
「選んで書いた true」は区別できない。区別する印を足すのは一度きりの出来事のために
仕組みを増やすこと。3台は設定パネルで外す。**次に既定を変えるときも同じ。**

## 2026-09-04 ホームに利用枠を常時出した（ウェブ版）

利用枠ページの「1ツール分の tier 一覧」を `QuotaCard.svelte` に切り出し、
`tierLabel` / `toolLabel` / `utilizationColor` / `utilizationBarColor` / `countdownStr` /
`formatQueryTime` / `isTrusted` / `riskLabel` を `$lib/quota.js` に移した。
利用枠ページはその部品を使う形に書き換え、**ホームは同じ部品を置いただけ**
（`charts={false}` で図の枠を描かない ── 取っていない履歴について「図が無い」と
言わないため）。ホーム用の描画は書いていない。

    位置    トップバー直下・警告バナーの下・トークンの大きな数字より上
    取得    fetchQuotas はホームで1回。バナーも同じ結果から派生（$:）
    失敗    「サーバがエラーを返しました。」を利用枠ページと同じ体裁で出す。空白にしない

### 実測（使い捨て serve 3998 に vite dev を proxy。本番の dist/web は不使用）

    利用枠ページ  切り出し前後の画像2枚 ── 差はカウントダウンと pace の数分ぶんだけ
    ホーム        Claude Code（5時間・Nimbus Quill・7日）と Codex（5時間・週間）が出る
    バナー同時    five_hour を 85% にした複製で、バナー「85%」とカードの「85%」が同時に出た
    serve 停止    利用枠の枠が赤字の1行になり、下のページ本体も失敗表示。空白なし

### 検証で作ったもの

  ・`vite.config.ts` の proxy 先を `AIUSAGE_API` で差し替え可能に（既定は従来どおり）。
    本番ハブはログインを要求するので、使い捨て serve に向けるため
  ・`.claude/web-dev.mjs`（未追跡）: vite dev を 5173 で起動し 3998 へ proxy
  ・Electron による固定寸法の画面取得。**URL を引数で渡すと Electron の既定アプリが
    「その URL を開く」と解釈して -1 で終了する。環境変数で渡すこと**
    （最初の3回は「窓が無い」と誤読した。GUI Electron は stdout も出さない）

### 未決（利用者が両方見てから）

閾値超えバナーと常時表示は同じ情報を2度言う。目立ち方が違うのでいまは残す。

## 2026-09-04 白黒と琥珀 ── 色の表を1つにしてから

### 案1: 色の表を1つ、両側は生成（`52ce08c`）

    scripts/theme/palette.cjs   テーマ × 変数 → 値。+layout.svelte の色ブロックを
                                値もコメントも**そのまま**移した
    scripts/theme/generate.cjs  ウェブ用と ウィジェット用の CSS を書く。`--check` で
                                置いてあるファイルが表と一致しなければ止める
    ウェブ                       71変数のうち色 60 を生成 CSS から。layout には形と書体だけ残る
    ウィジェット                 19変数を名前の対応表で生成（bg←bg, text-primary←text,
                                border←border-subtle, danger←danger-fg …）

**移し替えで値が変わっていないことを、値で確認した**: 元の layout から取った表と、
生成 CSS を読み戻した表が light 60 / dark 51 / kohaku 60 / terminal 67 で**不一致 0**。

**★ 生成物の鮮度ゲート**: 両パッケージの pretest と build に `generate.cjs --check`。
実測: 生成ファイルを手で1文字変える → build 停止（exit 1）。生成し直す → 通る。
これが無いと、表を1つにした意味は最初の善意の手直しで消える。

### 白黒（mono）── 色が言っていたことを、別の手段で

    ツールの印 ● ■ ◆   形のまま、全部墨色
    深刻度             塗りの濃さ（ok 0.50 / warn 0.38 / danger 0.15 L）＋
                       **90% 超は数字を反転**（墨地に白字）── 2軸。片方が消えても片方が残る
    古い値・繋がらない  文字のまま。赤字だった箇所は太字＋左に3pxの墨罫
    チャート5系列       灰の階調 0.20 → 0.65（約0.11 L 刻み）。**隣の系列の見分けは色より落ちる。
                       これは白黒の代償で、凡例が名前を持つ。数字での保証はしない**（画像あり）

コントラストは OKLCH の L から計算（灰なので Y = L³）: 文字18項目すべて 4.5 以上、
図形13項目すべて 3.0 以上、反転した％は 18.8。**書く前に検査し、割る値は書かせない**。
1回目はチャートの薄い2段（2.98・1.79）が 3 を割ったので階調を 0.65 まで詰めた。
`--border-medium` は仕切り線なので 3:1 の対象から外した（ライトの同変数も超えない）。

**トレイは対象外**。緑・黄・赤は窓が畳まれても隠れても残る唯一の深刻度の信号で、
テーマではない。tray-icon.ts にその1行。

### ウィジェット側

  ・`prefers-color-scheme` をやめ、`data-theme` に。**`system` は起動時と
    `nativeTheme` の `updated` で light/dark に解決して付け直す**（media query が無償で
    していたことを、こちらで持つ）。純粋関数 `theme.ts` にしてテストした
  ・ライト／ダークの値が**ウェブのものに変わった**（同じ名前が同じ見た目を指す、の帰結）。
    差は小さい（例: bg 0.985/0.004 は同じ、dark bg 0.18 → 0.13）
  ・ロゴの緑が固定値だったので `var(--accent)` に。白黒で唯一の色になっていた

### ★ 途中で見つけた: インライン style が白黒の反転を殺していた

ウェブの ％ は `style="color: {utilizationBarColor(...)}"` で色を付けていた。
白黒の反転ルールは `color: white` を指定するが、**インライン属性がすべての規則に勝つ**ので
墨地に墨の字 ── 箱だけ見えて数字が無い。実測画像で見つけた。
色は `level-*` クラスで付ける形に変え、ライトでは 95% 赤・75% 橙・7% 緑のまま（画像で確認）。

### 実測（画像）

    ウィジェット 白黒   ●■ 墨 ／ 95% 反転 ／ 「3時間4分前の値 — 更新が止まっています」／
                        ハブ停止「ハブに繋がりません（…）」太字＋墨罫。4つとも読める
    ウィジェット 琥珀   ウェブの琥珀と同じ値（テスト: 生成 CSS の kohaku ブロック == 表）
    設定パネル          システム／ライト／ダーク／琥珀／白黒 の5つ
    ウェブ 白黒         利用枠（反転 95%）、トークン（灰の5系列チャート）
    ウェブ 既存4テーマ  値の不一致 0（上記）

**未実測**: `system` のまま OS のテーマを切り替えて窓が追随すること。
OS の設定はこちらで触らない。利用者に1回だけ切り替えてもらう。

## 2026-09-04 引き継ぎ

未処理と作法の圧縮版は **HANDOFF.md**。このファイルは追記のみで長いので、次のセッションはまずそちらを読む。
