# 決定ログ

「なぜそうなっているか」の記録。ここに理由がある実装を、
理由を読まずに「きれいにする」目的で変更しないこと。

## D1. device_instance_id は 'unknown' のままにする

本番の records 10,000件超はすべて `device_instance_id = 'unknown'`。
state.json が長らく存在しなかったためのフォールバック値。
これを正規の UUID に変えると2つ壊れる。

1. `v_agent_sessions` は `(agent_session_id, tool, device_instance_id)` で
   records と JOIN する。agent_sessions だけ UUID になると usage が全件 NULL になる。
2. `record_id = sha256(deviceInstanceId, sourceFile, lineOffset)`。
   deviceInstanceId が変わると同じ行の再パースで別 id が生成され、
   コストが二重計上される。

正規化する場合は records / synced_records / sync_tombstones の
バックフィルと watermark の影響分析が必要。単独では変更しない。

`ensureAiusageDir` は state.json が無いとき、records に既にある
device_instance_id を採用する（`findPredominantDeviceInstanceId`）。
records が空のときだけ新しい UUID を発行する。

## D2. StopFailure は failed ではなく waiting_for_user

StopFailure は「API エラーでターンが終了した」ときに発火する
（error_type: rate_limit / overloaded / authentication_failed / billing_error など）。
セッションが死んだわけではない。

`failed` は終端状態で、調停ルール2により以降のイベントを全て却下する。
ここを failed にすると、レート制限1回で生きたセッションが永久凍結され、
以後の user_prompt も Stop も通らなくなる。

error_type は payload と status_detail に残すので、
Phase 7 は `last_event_kind='stop_failure'` と `payload.error_type` を見て
「レート制限で止まりました」と通知できる。

`failed` への到達経路は SessionEnd の error 系のみ。

## D3. waiting_* は30分無音ルールの対象外

無音が異常の証拠になるのは、何かが起きているはずの status だけ。

- `running` / `idle` → 無音は異常。30分で unknown に落とす
- `waiting_for_user` / `waiting_for_permission` → 人間の応答待ち。無音が正常

許可待ちの30分無音は「人がまだ答えていない」という意味で、
まさに通知の価値が出る瞬間。ここで unknown に落とすのは
このプロジェクトで最も価値のあるシグナルを、価値が出た瞬間に捨てること。

waiting_* の終了経路は「24時間無音 → completed(timeout)」と
「プロセス消失 → completed(process_gone)」の2つのみ。
後者の検出は Phase 5 で実装する（exit_reason の文字列だけ用意済み）。

## D4. confidence はサーバ側の固定値

送信側に confidence を決めさせない。source 種別だけを信じる。
manual 1.00 / hook 0.95 / log 0.70 / heartbeat 0.50 / process 0.30 / derived 0.20。
リクエストの confidence を尊重するのは source='manual' のときのみ。
送信元が増えるほど値の一貫性が崩れるため。

status を主張しないイベント（heartbeat / subagent_stop）は
confidence 判定の対象外。順位争いは status を主張するもの同士でのみ行う。
これが無いと heartbeat が唯一の仕事（TTL 延命）を果たせない。

却下されたイベントも `status_after = NULL` で記録する。
「言われたが不採用」と「何も来なかった」を区別できないと調停を検証できない。

## D5. dedupe_key に last_event_kind を含める

Stop と StopFailure は同じ `waiting_for_user` / 同じ `status_since` に着地する。
status だけで dedupe すると StopFailure が INSERT OR IGNORE で黙って捨てられる。

同じ理由で、AgentSessionEmitter は status 変化だけでなく
`kindChanged`（last_event_kind の変化）でも emit する。

## D6. 寛容な JOIN を残す

`u.session_id = s.agent_session_id OR u.session_id LIKE '%' || s.agent_session_id`

v17 で records.session_id をバックフィルした後も削除しない。
将来 sync を有効にしたとき、未修正版の Windows 端末から
パス形の session_id を持つ行が流入しうる。等号側が先に評価されるので
正常データでのコストは実質ない。

## D7. コストは「API 従量換算」であって請求額ではない

契約は Claude Max（stripe_subscription / claude_max）。従量課金ではない。
records の cost は「同じ使用量を API 従量で払った場合の相当額」。
実際の消費率は Phase 6-A のクォータ（5時間枠 / 週枠の %）が担う。

両方に意味がある:
- クォータ % → 契約枠をどれだけ使ったか
- コスト → サブスクの元が取れているか

UI で表示する際は「請求額」と誤読されない表記にすること。

なお LiteLLM から引ける claude 系の単価は
`vertex_ai-anthropic_models` 由来であり、Anthropic 直販の価格表ではない。

## D8. 通知は既定 OFF、併走は prefix で識別

Phase 7 は `notifications.enabled = false` で出荷する。
既存の PowerShell 通知と両方 ON の期間があってよいが、
その間 aiusage 側は prefix `[aiusage] ` で見分けられるようにする。

移行は3段階: ①webhook 設定＋疎通確認 → ②併走して文言一致を確認 →
③既存 hook から Discord 呼び出しを除去。②は3日〜1週間。

段階3では `start-task-timer.ps1` と `~/.claude/task-times/` も不要になる
（agent_session_spans が全ターン・全状態を保持しているため）。

## D9. 期限切れの通知は配信せず dropped にする

3時間前の「確認待ち」が今届くのは無価値どころか有害。
outbox の `expires_at` は session_status / escalation が15分、
quota 系が60分。

## D10. last_assistant_message は既定で送信しない

既存の stop-discord-notify.ps1 は応答本文を Discord に投げているが、
これは応答内容の外部サービスへの送信にあたる。
既存挙動を無断で引き継がない。
`notifications.includeAssistantMessage` を明示的に true にしたときのみ、
200文字で切り詰めて含める。

この判断は今も有効で、既定は OFF のまま。
既定を OFF にした理由（応答本文の外部送信であること、
既存挙動を無断で引き継がないこと）は変わっていない。

### 2026-08-30: この端末では明示的に有効にした

ユーザーの判断で `includeAssistantMessage = true` を設定した。
理由は「既存の PowerShell 通知が既に本文を送っており、外すと
今ある情報が減る」「複数エージェントを並列で動かしているため、
本文が無いとどれが何を終えたのか分からない」
「通知先が本人専用チャンネル」。

この時点まで、この機能は表示側しか実装されていなかった。
formatSessionMessage は `input.assistantMessage` を見て「応答:」行を
組み立てていたが、その値を渡している箇所が存在せず、
ホワイトリストも本文フィールドを落としていた。
設定を true にしても何も起きない状態だったので、取得側を実装した。

### 切り詰めは取得時点で行う

全文を保存して表示時に切り詰める作りにはしない。
DB は同期・バックアップされ、他のツールからも読まれる。
通知の2行のために会話全文をそこへ置く理由は無い。

`normalizeAssistantPreview`（core）が取得側で 200 文字に切り詰め、
改行と連続空白を空白1つに畳む。返信は複数行、通知は1行であり、
複数行のまま payload 列に入れても下流が扱いにくいだけ。

ツールごとに元のキー名が違う
（Claude Code の Stop は `last_assistant_message`、
  Codex の task_complete は `last_agent_message`）ので、
保存時に `assistant_preview` へ正規化する。下流で分岐させないため。

「応答:」行が出るのは作業完了のときだけ。
通知側は最新の `kind='stop'` イベントからしか読まない。
セッション終了・エスカレーション・クォータ通知は別の出来事であり、
直前のターンの本文を貼っても古い情報にしかならない。

同じ方針で、hook payload はホワイトリスト方式で必要なキーだけを保存する。
落としたキーは名前だけ `payload._droppedKeys` に残す（値は残さない）。
実測で落ちているのは prompt / last_assistant_message / background_tasks /
effort / session_crons / session_title の6つ。

## D11. 許可待ちは PermissionRequest で確定判定する

`PermissionRequest` hook がこの Claude Code で実際に発火することを実測確認済み
（2026-08-30 01:54:34）。
`Notification` の message を正規表現で判定する経路はフォールバックであり、
実運用では使われていない。

classifyNotification の優先順位:
① kind='permission_request' → 確定
② notification_type が permission 系
③ message の正規表現（英日）
④ いずれも該当せず → waiting_for_user
③④ に落ちた message は payload に丸ごと残す（パターン追加の材料）。

## D12. 'sending' から復帰させる

送信中にプロセスが落ちた通知は、起動時に pending へ戻す。
実際には送信済みだった場合に重複が1通出るが、
重複1通と通知の恒久消失を比べれば前者が明らかにまし。
expires_at で上限も掛かる。この重複を「直す」目的でこの処理を削除しないこと。

## D13. AIUSAGE_HOME を導入した理由

`AIUSAGE_DIR` が `homedir()` にハードコードされていたため、
ハーネスが起動したプレビューサーバが本番DBを開いてマイグレーションした
（2026-08-29 15:11、実際に発生）。
config.ts の1定数を env で上書き可能にすることで、
14ファイルすべての起動経路が追従する。

`quota.ts` と `discovery.ts` の `homedir()` は変更しない。
これらは他社ツールの実際の保存場所であって、aiusage 自身のデータではない。

## D14. Webhook 送信は runDbWrite の外で行う

通知を決めるコードは DB トランザクションの中で走る。
書き込みキューは直列で parser / sync と共有しているため、
その中で webhook を POST すると全ての書き込みが webhook 待ちで止まる。

送信は3段構え: ①キュー内で claim して state='sending'
→ ②キュー外で POST → ③キュー内で結果を書き戻す。
パース実行中はティックをスキップする（better-sqlite3 が同期実行のため、
イベントループが塞がって fetch のタイムアウトだけが経過する）。

同じ理由で、Phase 6-A の起動時クォータ取得はパース完了後に回してある。

## D15. cost_source は価格が引けたかで決める

`claude-code.ts` と `codex.ts` だけが `model === 'unknown'` で判定しており、
価格表に無いモデルでも `cost=0 / cost_source='pricing'` になっていた。
これが「総コスト $0」を長期間不可視にしていた。
他の全パーサは `hasPrice ? 'pricing' : 'unknown'` で正しい。

`/api/summary` は `unpricedRecords` と `unpricedModels` を返し、
serve 起動時にも同条件で warn を1行出す。
同じ問題が静かに再発しないようにするための可視化。

## D16. serve は既定でループバックにバインドする

以前は無条件に `0.0.0.0` で listen していた。ダッシュボードのパスワードは
任意なので、既定の状態では同じ LAN の誰でも総コスト・プロジェクト名・
セッション履歴・サブスク消費率を読めた。

優先順位は `--host` > `AIUSAGE_HOST` > `127.0.0.1`。
非ループバックにバインドする場合、`AIUSAGE_DASHBOARD_PASSWORD` が
無ければ起動を拒否する（exit 1）。既にリバースプロキシや閉じた
ネットワークで守られている環境のために `AIUSAGE_ALLOW_INSECURE_HOST=1`
を逃げ道として残すが、その場合は警告を1行出す。

「パスワードを常時必須」にしなかったのは、単一マシン利用では何も露出して
おらず、パスワードが純粋な摩擦になるため。既定を狭くして、広げる側に
明示を求める形にした。

非ループバックのときは `shouldProtectApiPath` の `/api/summary` と
`/api/quotas` の除外も無効化する。この2つはトップページの表示に必要で
ループバックでは無害だが、ネットワークから見える状態では
「守るべき中身そのもの」になる。

ループバック判定は文字列一致で、DNS 解決はしない
（`127.0.0.1` / `::1` / `localhost` / `[::1]`）。
セキュリティ判断が解決結果に依存すると、環境ごとに挙動が変わる。
`127.0.0.2` のように 127/8 だが一致しないものは「非ループバック」に倒す。
誤りの代償がパスワード1つで済む向きを選ぶ。

Docker はネットワークから到達できて初めて意味があるので、Dockerfile の
CMD には `--host 0.0.0.0` を明示した。結果として、コンテナ利用者は
パスワードを設定しない限り起動できない。これは意図した挙動。

判定は `runServeCommand` に置き、`createDatabase` より前に走らせる。
createDatabase はマイグレーションを伴うため、順序が逆だと
「起動は拒否されたのに本番DBだけスキーマが上がっている」が成立する。

### 2026-08-30: 複数アドレスへのバインド（8-B-1）

`--host` はカンマ区切りのリストを受け付ける。
127.0.0.1 は明示されなくても常に listen する。

agent-event は `.serve-port` を読んで http://127.0.0.1:<port> に POST し、
widget は http://localhost:<port> に繋ぐ。
単一の非ループバックアドレスにバインドすると、この2つが到達不能になる。
しかも agent-event は送れなかったイベントを spool に積むので、
エラーもログも出ないまま hook のイベントが全て溜まり、通知が止まる。
設計どおりに失敗するので気づけない。

パスワードの要否はリスト全体で判定する。
非ループバックが1つでもあれば必須。
`/api/summary` と `/api/quotas` の公開も同じで、
「すべてのリスナーがループバックのときだけ」開ける。

一部のアドレスの listen 失敗では serve 全体を落とさない。
典型的な原因は Tailscale が起動していないことで、
VPN が落ちている間に hook のパイプラインと通知まで止まるのは割に合わない。
失敗は warn を1行出して次へ進む。

なお、要求された非ループバックアドレスの listen が失敗しても
保護は解除しない。「要求された時点で公開する意図があった」と読む。
listen の成否で保護の有無が変わると、競合状態に依存することになる。

### 2026-08-30: ingest トークンはパスワード検査を通過する

ダッシュボードパスワードを設定すると、
X-Aiusage-Token を持つ hook の POST まで 401 になっていた。
hook は別プロセスで cookie を持たないため、パスワードを設定した瞬間に
全イベントが spool 行きになる。これも無言で失敗する。

トークンはパスワードの代わりになるが、逆は成り立たない。
ダッシュボードの cookie があっても ingest トークンの要求は免除されない。
前者は「このダッシュボードを読んでよい」、
後者は「この端末の hook である」であり、書き込みに足りるのは後者だけ。

トークンはパスワード検査を全ての保護パスで通過する。
トークンは 0700 のデータディレクトリ内の state.json にあり、
それを読める者は既にダッシュボードの元データを読める。
パスワードが守るのはネットワークであって、ローカルのファイルではない。

パスワードは環境変数のほか config.credentials.dashboardPassword からも
読む（優先順位は環境変数が上）。手動起動の運用で毎回 export するのは
現実的でなく、忘れるのは非ループバックで起動する時である。
設定は `aiusage set-dashboard-password`（stdin から読む）。

## D17. quota テーブルに空の device_instance_id を記録しない

state.json が無い期間、device_instance_id は '' だった。
state.json 生成後は 'unknown' になり、同じ tier が
2系列に分裂した（v18 で '' 期間を削除）。

recordQuotaSnapshot は空文字を受け取ったら記録せず warn を出す。
空文字は「まだ state.json が無い」状態であり、
そのまま記録すると後から必ず分裂する。
D1（device_instance_id は 'unknown' のまま）と併せて読むこと。

バックフィルではなく削除を選んだのは、snapshot id と window_id が
device_instance_id を含むハッシュだからである。列だけ書き換えると
「自分の入力から導出できない id」が残る。実害は無いが、
次にこのテーブルを調べる人間に対する罠になる。

## D18. Codex の状態は rollout ログから取る

Codex には Claude Code の hooks に相当する仕組みが無い。
`notify` は単一プログラムしか登録できず、この端末では既に
computer-use が使っている。上書きすると連携が壊れる。
`hooks.json` は PreToolUse / PostToolUse のみで、しかも
シェルツール限定。ライフサイクルイベントを持たない。

一方 rollout ログ（~/.codex/sessions/**/rollout-*.jsonl）には
session_meta / user_message / task_started / task_complete が
すべて記録されている。aiusage は既にこのファイルを parse しており、
読む対象は増えない。Codex 側の設定変更も不要。

確認待ちは取得できない。該当するイベント型が存在しない
（10セッション 55,373行を横断して0件）。
Codex については「作業中 / 完了」の2状態のみを扱う。

ログ由来なので confidence は 0.70（D4）。hook の 0.95 より低く、
Claude Code と混在しても調停が正しく働く。

過去の再生は byte offset のカーソル（v19 の agent_log_cursors）で防ぐ。
初見のファイルは先頭ではなく現在の末尾から読み始める。1本 44MB の
ファイルを先頭から読めば、完了済みのターンが数千件そのまま通知になる。
「初回観測では通知しない」（quotaThresholdCrossings）と同じ原則で、
基準が無いものは報告しない。

例外は session_meta の1行だけで、これは初見時にも読む。
セッション行と cwd をそこからしか得られないため。
ただし生成するイベントは status を持たない（kind='process_scan'）ので、
過去から状態を推定することにはならない。

ディレクトリは「セッションが始まった日」で切られており、
最終更新日ではない。08/27 に始めて 08/30 まで続いているセッションは
08/27 のディレクトリにある。直近N日のディレクトリだけを見ると、
最も追尾する価値のある長寿命セッションを取りこぼす。
カーソルを持っているファイルは、ディレクトリの日付に関わらず対象にする。

追尾開始の規則には例外がある。rollout のファイル名に含まれる
セッション開始時刻が10分以内なら、初見でも先頭から読む。
生まれたばかりのファイルには再生すべき履歴が無く、
末尾から始めると新規セッションの最初のターンを毎回取り逃すため
（実測で turn_count=0 になった）。
ファイルの birthtime ではなくファイル名の時刻を使う。
birthtime はコピーや同期で狂うが、ファイル名は狂わない。
5MB を超える場合は末尾から読む（10分でそこまで育つのは異常）。
ファイル名から時刻が読めない場合も末尾から読む（安全側に倒す）。

Codex Desktop は Documents/Codex/<日付>/<連番> をアドホックな
作業領域として使う。ここは project として扱わない。
判定はホーム配下であること・日付・連番の3つすべてを要求する
（Documents/Codex という名前の実プロジェクトを誤判定しないため）。
Codex 固有の知識なので codex-log-watcher 側に置き、
全ツール共通の extractProjectFromCwd には入れない。
project が空のときは通知の「プロジェクト:」行を出さない。

device はウォッチャ側でも config.device を読む。
hostname() で埋めていたため、同じ端末が Claude Code では「自宅PC」、
Codex では「DESKTOP-...」として同じ通知チャンネルに並んでいた。
applyAgentEvents の更新も ctx.device を行の値より優先するようにした。
優先しないと、最初に間違った名前で登録された行が一生そのまま残る。

## D19. 通知ラベルは core と UI で二重管理している（現状の記録）

core の `notificationLabel` が (status, lastEventKind) から
「🟢 作業完了」のようなラベルを返す。Discord 通知はこれを使う。
UI（/agents）は同じ対応関係を `agent-status.js` に持ち、
文言は web の i18n から引く。同じ知識が2箇所にある。

なぜそうなっているか: core のラベルは日本語固定で en / zh を持たない。
UI は3ロケールを出す必要がある。core をそのまま import しても
日本語しか得られず、packages/web に core への依存も増える。

一本化するならこうする（今はやらない）:
core の notificationLabel を2つに割る。
  labelKeyFor(status, lastEventKind) → 'waiting_for_user' のような
  安定した識別子を返す。これはドメインの判断。
  文言は core 内の ja 辞書に置き、Discord 側はそこから引く。
UI は同じ識別子で web の i18n を引く。
判断は1箇所、文言は表示先ごと、という分担になる。
混ざっているのが問題の本体で、
「ドメインの判断」と「表示の都合」を分ければ解ける。

なぜ今やらないか: テストで一致が縛られており、実害が出ていない。
`packages/web/tests/agent-status.test.ts` が core の関数を実際に呼び、
ja の文言と絵文字が一致することを検証する
（stop_failure が status より優先される規則を含む）。
ラベルがずれたらテストが落ちる。
将来ずれる事故が起きたら、この記録から着手すること。

なお同テストは packages/web から core を相対パスで import している。
依存を増やさないための措置で、テスト限定であり本番バンドルには入らない。
