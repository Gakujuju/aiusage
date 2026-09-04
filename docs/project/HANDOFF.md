# HANDOFF ── 実装役チャットの引き継ぎ（2026-09-04 時点）

長い履歴を圧縮したもの。詳細は STATE.md（追記のみ・長い）、判断は DECISIONS.md、
手順は SETUP-NEW-MACHINE.md / OPERATIONS.md。**このファイルは「いま何が未処理か」が主。**

## 役割と作法

- 別チャットの**指示役**が設計判断を出し、このチャット（**実装役**）は指示された範囲だけ実装して
  日本語のコードフェンスで報告する。範囲を勝手に広げない。提案が求められたら**実装前に止まる**。
- 報告は実測を添える。数字に根拠が無いときは「根拠が無い」と書く。前提が違っていたら訂正を報告する。
- 常設の制約（原文のまま）:
  本番DBに書き込む作業は事前報告・承認 ／ 本番 serve を止める必要が出たら事前に報告 ／
  推測で片付けない・特定できなければ「特定できなかった」／ 公開済み履歴に触らない・force push 禁止 ／
  VAPID 秘密鍵・ingest トークンは config.credentials、レスポンスにもログにも出さない ／
  VAPID の sub に既定でメールを入れない ／ 通知許可は利用者操作をきっかけに ／
  p256dh・auth を GET に含めない ／ バックアップ検証は複製に対して ／
  AIUSAGE_HOME を設定せずに DB パスだけ差し替えない ／ 未承認マイグレーションを dist に入れない ／
  `/api/*` は絶対にキャッシュしない ／ **docs の識別情報チェックを毎回**
  （gy8000466914 / Gakujun / DESKTOP- / jun-m / 100.x / ts.net ── 追加行のみ grep、0件でコミット）

## いまの状態（HEAD `f50af9c`、push 済み）

- 構成: ハブ＝自宅PC（このPC、port 3847、tailnet にも bind → `/api/*` はログイン必須）。
  spoke＝職場PC・ノートPC。ウィジェットは全台ハブへ HTTP でログインして読む（D29）。
- **本番 serve は 2026-09-03 01:03 起動のプロセスのまま**（`c96753c` 時点のコード）。
  それ以降の CLI/ウェブ変更（no-parse 稼働時間化 `119b8dd`、ホーム利用枠 `6fbc674`、テーマ `52ce08c` `f50af9c`）は
  **本番に未反映**。`packages/cli/dist` は `970d9aa` 時点で再ビルド済みだが、**dist/web は古い**
  （ウェブは `aiusage-update.cmd -WithWeb` で入る）。反映には serve 再起動＝**承認が要る**。
- ウィジェット（このPC）: 普通サイズ・畳んだ状態・theme=system・本番ハブ。単一インスタンスロックあり。

## 未処理（承認待ち・利用者待ち）

1. **8-b**: このPCの `aiusage-serve` タスクを `wscript.exe` ＋ `start-serve-hidden.vbs` に差し替える
   （`Set-ScheduledTask -Action`。実測済み・管理者不要）。いまも5分ごとに cmd の窓が出ている。
2. **`aiusage-widget` タスク登録**（このPC・SETUP 11-5b）。`start-widget.cmd` / `.vbs` は生成済み。
3. **dist 反映**（上記。serve 停止→再起動、`aiusage-update.cmd -WithWeb`）。
4. 利用者の実測待ち: PC 再起動後にウィジェットが自動で出ること ／ `system` のまま OS のテーマを
   切り替えて窓が追随すること ／ 職場PCの取り込み（`~/.aiusage/aiusage-update.cmd`、PATH に無い）。
5. 利用者の判断待ち: ホームの閾値バナーと常時カードを両方残すか（画像は送付済み）。
6. 未計算: `palette.cjs` の kohaku / terminal の `--mark-*` は暫定値で**コントラスト未確認**
   （light/dark/mono は計算済み）。
7. 保留の古い項目: 黙った spoke の段階3・4、upstream issue 起票（10件）、`/api/quotas/refresh` の連打制限、
   packaged ビルドの未走行分岐と `isPackaged` の代用（STATE 参照）。

## 今日までに入った主なもの（1行ずつ）

- `/api/quotas` は `quota_current` から返す（上流を叩かない）。ウィジェットは1回の取得を両表示で使う。
- ウィジェット: 401 でも unreachable でも起動して窓に理由を出し、届くまで poll。pid ファイル判定は撤去。
- 帯（折りたたみ）／4段階サイズ（zoomFactor は初回だけ移行）／ツール印 ●■◆ ／ 数字入り帯。
  Windows の枠なし窓は高さ 39 px（透過ありなら 64）より低くならない → `FRAMELESS_MIN_HEIGHT_WIN`。
- 設定パネルは既定値でなく状態を見せる（アドレスの実値・パスワードの3状態）。
- テーマ: **色の表は `scripts/theme/palette.cjs` 1つ**。`generate.cjs` が web/widget の CSS を生成し、
  `--check` が両パッケージの pretest/build で鮮度を止める。**生成 CSS を手で編集しない。**
  白黒（mono）は L から計算で 文字4.5 / 図形3 を保証。トレイの色はテーマ対象外。
- ウェブ: ホーム最上部に利用枠カード（`QuotaCard.svelte`、`$lib/quota.js`）。fetchQuotas は1回。
- no-parse 警告は稼働時間で測る（min(実間隔, 想定間隔) の累積。境目なし）。

## 検証の道具（スクラッチは掃除で消える。必要なら作り直す）

- 使い捨て serve: `AIUSAGE_HOME=<dir>`（**そのディレクトリ自体が .aiusage 相当**。`.aiusage/` を切らない）、
  `config.json` に host 127.0.0.1・credentials 無し・quotaSnapshotInterval 0 → API が開く。`cache.db(-wal,-shm)` を複製。port 3998。
- ウェブ preview: `.claude/web-dev.mjs`（未追跡）が vite dev を 5173 で起動し `AIUSAGE_API` で 3998 へ proxy。launch.json の "web"。
  本番ハブはログインを要求するので proxy 先にしない。ログインはこちらでは行わない。
- 窓の計測: EnumWindows でタイトル一致を探す（`Process.MainWindowHandle` は SetWindowPos 後に外れる）。
  画像は Electron で offscreen capture（**URL は引数でなく環境変数で渡す** ── 既定アプリが URL 引数を横取りする）。
- ウィジェットの kill: `Stop-Process` が拒否されることがある → `Invoke-CimMethod -MethodName Terminate`。
  ExecutablePath の無い electron.exe は幽霊。プロセス数で数えない。
- 落とし穴: CRLF ファイルでは複数行アンカーを `\r?\n` で ／ bash ヒアドキュメントはバックスラッシュを食う → スクリプトは Write ツールで ／
  PowerShell で config.json を読まない（`ConvertFrom-Json` の失敗出力に秘密が出た前歴） ／
  GUI の Electron は stdout を出さない ／ 出力を絞りすぎると「スクリプトが無い」が「窓が無い」に見える。
