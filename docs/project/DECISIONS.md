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
