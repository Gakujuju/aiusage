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
| 8 | Android/PWA 化 | 未着手（8-B が残り） |

## 未消化の作業

- Phase 5 のクローズ確認のうち、スクラッチ作業での通知1点
  （実プロジェクトでの動作は 2026-08-30 13:27 のセッションで確認済み）
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

- 本番 serve: ポート 3847
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

方針: 1・2・3・6 は挙動を壊さない明確なバグ修正なので1つの PR に
まとめてよい。4・5 は影響が大きいので個別に issue から始める。
まだ作成していない。

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
