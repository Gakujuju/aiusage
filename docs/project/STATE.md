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
