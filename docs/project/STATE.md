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
