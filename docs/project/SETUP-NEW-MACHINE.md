# 新しい端末を追加する

※ 山括弧の値は各自の環境のもの。ハブの名前は `tailscale status`、
自分がどこへ送っているかは `aiusage hub-status` で確認できる。

自宅PC（<ハブのホスト名>）がハブで、他の端末はそこへ送るだけの
spoke になる。spoke は自分のログを parse して自分のDBに入れ、
agent イベントは即時に、usage レコードは20分間隔でハブへ送る。

ダッシュボードはハブでだけ開く。spoke の serve は 127.0.0.1 のみに
bind し、`tailscale serve` も要らない。

実地記録: ノートPC (<ユーザー名>) 2026-08-31。所要 約1時間、うち大半は
下記「踏んだ罠」の解決に費やした。

## 前提

- Tailscale に参加済み（tailnet に3台以上いても課金されない）
- Node.js 20 以上、git、pnpm
- ハブ側で `tailscale serve` が動いており、
  `https://<hub>.<tailnet>.ts.net/api/auth/status` が 200 を返す

## 手順

### 1. クローンとビルド

```bash
git clone https://github.com/Gakujuju/aiusage.git
cd aiusage
pnpm install
```

**ルートの `pnpm build` でも通るようになった**（widget の
`rm -rf` を `node -e` の `fs.rmSync` に置き換えたため)。
ただし spoke に widget は要らないので、下の3つだけで足りる。

```bash
pnpm --filter @aiusage/core build && pnpm --filter @aiusage/web build && pnpm --filter @juliantanx/aiusage build
```

`Web build copied to dist/web` まで出れば良い。

新しいコードが入っているかの確認:

```bash
node packages\cli\dist\index.js hub-status
```

`Hub: none.` が出ること。`unknown command` なら古いコードなので
`git pull` からやり直す。

**ただし `hub-status` が示すのは set-hub 系（9-1）が入っていることだけで、
レコード直送（9-3）が入っているかまでは保証しない。**
確実に見るならハブ側と突き合わせる:

```bash
git log --oneline -1
```

ハブで同じコマンドを実行し、同じコミットか、spoke の方が新しいこと。
最終的な確認は手順9で行う。

**`init` は実行しないこと。** upstream のクラウド同期（GitHub/S3）用で、
Tailscale 直送とは別物。

### 2. 初回 serve

```bash
node packages\cli\dist\index.js serve
```

`[migration] applying v1..vN to <パス>` が流れ、`created state.json` が出る。
**パスが自分の `%USERPROFILE%\.aiusage\cache.db` であることを必ず確認する。**
確認したら Ctrl+C で止める。

続いて state.json の中身を確認する:

```bash
type "%USERPROFILE%\.aiusage\state.json"
```

`deviceInstanceId` が **`"unknown"` でないこと**。
新品の端末なら UUID が発行される（ノートPCは
`a9ef90d2-5563-4bb8-9f75-237426d7e1fa` だった）。

`"unknown"` だった場合、その端末には旧 aiusage の records が
既にあり、init.ts がそれを引き継いでいる。ハブ（自宅PC）の
deviceInstanceId も `"unknown"` なので、**そのまま進めると
ハブ側で2台を区別できなくなる**。この場合は先に相談すること
（records・synced_records・sync_tombstones の同時backfillが要る。D1参照）。

### 3. ハブのトークンを取得

**ハブ（自宅PC）で実行する。** spoke で `%USERPROFILE%` を使うと
自分自身のトークンが出るだけで、それを入れても 401 になる。

画面に出さずに運ぶ（推奨。リモートデスクトップならクリップボードが渡る）:

```powershell
(Get-Content "$env:USERPROFILE\.aiusage\state.json" | ConvertFrom-Json).ingestToken | Set-Clipboard
"copied: $((Get-Clipboard).Length) chars"
```

`copied: 36 chars` が出ること（トークンが UUID の場合。
桁数そのものより、0 でないことを見る）。

クリップボードが端末をまたがない場合は絶対パスで表示する:

```bash
type "C:\Users\<ハブのユーザー名>\.aiusage\state.json"
```

**メモ帳などに貼って運んだ場合は保存せずに閉じること。**
運び終えたらクリップボードも消す: `Set-Clipboard -Value " "`

### 4. ハブを設定

spoke で:

```bash
node packages\cli\dist\index.js set-hub https://<hub>.<tailnet>.ts.net
```

`Receiving machine's ingest token:` に貼り付ける。
PowerShell 内では**右クリックで貼り付け**（Ctrl+V は効かない）。
**入力は画面に一切表示されない。** アスタリスクも出ないが正常。

`This machine now reports to ...` が出れば保存されている。
`Nothing was entered.` なら貼り付けが入っていない。

**set-hub はトークンの正しさを検証しない。** 保存するだけなので、
間違っていても成功したように見える。手順9で必ず実地確認する。

### 5. hook を登録する

Claude Code の agent イベントは hook が送る。これを登録しないと、
**レコードは届くが作業状態は永久に届かない**。手順9の確認は
レコードしか見ないので、欠落に気づけない。

```bash
node packages\cli\dist\index.js agent-event --print-hook-config
```

出力の JSON 断片を `~/.claude/settings.json` に足す。
同じイベントに既存の hook があっても壊れない
（Claude Code は登録された hook を全部それぞれ実行する）。

**出力に含まれる `aiusage agent-event --tool claude-code` は
そのままでは動かない。** `aiusage` は PATH に無い。
自宅PCの実際の設定と同じく、次の形に書き換えること。

    node "<チェックアウトの絶対パス>\packages\cli\dist\index.js" agent-event --tool claude-code

登録後、Claude Code を1回起動して
ハブのダッシュボードにセッションが現れることを確認する。

Codex は hook を持たないので、この工程は不要。
Codex の状態はローカル serve が rollout JSONL から導出する。

### 6. spoke の設定

```bash
node packages\cli\dist\index.js serve
```
を止めた状態で `~/.aiusage/config.json` に次を足す。

    "quotaSnapshotInterval": 0,
    "notifications": { "enabled": false }

`quotaSnapshotInterval: 0` は必須。spoke がクォータを取っても、
クォータ行は SYNC_FIELDS に無いのでハブへ送られない。
同一アカウントを複数台から叩くだけで、429 の原因になる。
0 を入れるとタイマーが張られない（settings-controller.ts:147）。

`notifications.enabled: false` も必須。**Codex を使う端末では
保険ではない。**

Claude Code は hook が `hubForward` を見てハブへ直接送るので、
その分の `agent_sessions` はローカルには入らない。
だが Codex には hook が無く、ローカル serve が rollout JSONL から
状態を導出して `applyAgentEvents` でそのままローカルDBに書く
（serve.ts の codex log watcher）。**この経路は `hubForward` を見ない。**
したがって Codex を使う端末では `agent_sessions` が埋まり、
通知を切っていなければ spoke 側でも発火する。

同じ理由で、**Codex の作業状態はハブに届かない**。
届くのは usage レコードだけで、ハブの /エージェント には
その端末の Codex セッションは出ない（未解決。下記「踏んだ罠」参照）。

### spoke はヘッドレスで動く

**ダッシュボードはハブでだけ開く。spoke の画面は開かない。**
spoke の serve は自分のログを読んでハブへ渡すためだけに存在する。

このことが取り込みの駆動に効く。upstream の設計では、
**画面を開いた人がパースを駆動する**（`/api/refresh`）。
単一マシンなら筋が通っていて、見ていない間に解析が走らなくても
誰も困らない。

spoke では成立しない。誰も画面を開かないので、
何も駆動されない。しかも**ハブへの送信はパースから駆動される**ので、
パースが走らなければ送信も走らない。

そのため serve は既定で**5分ごとにパースする**
（`DEFAULT_PARSE_INTERVAL_MS`）。
`~/.aiusage/config.json` の `refreshInterval` で変えられ、
`0` を明示すれば従来どおり無効になる。

    "refreshInterval": 300000    // 明示したいとき（ミリ秒）
    "refreshInterval": 0         // 無効（画面を開いたときだけ解析）

**spoke では 0 にしないこと。** ハブへ何も届かなくなる。

### 7. 常駐スクリプト

```powershell
$cmd = @'
@echo off
rem Started by the aiusage-serve scheduled task: once at logon, then every
rem 5 minutes. The repeat is the watchdog.
rem This machine reports to a hub (see: aiusage hub-status) and binds
rem 127.0.0.1 only - it is not the machine anyone opens the dashboard on.
rem Remove the task with:  Unregister-ScheduledTask -TaskName aiusage-serve

set "AIUSAGE_CLI=<チェックアウトの絶対パス>\packages\cli\dist\index.js"
set "AIUSAGE_LOG=%USERPROFILE%\.aiusage\serve.log"
set "AIUSAGE_PORT_FILE=%USERPROFILE%\.aiusage\.serve-port"
set "AIUSAGE_PORT=3847"

if not exist "%AIUSAGE_CLI%" (
  echo [%DATE% %TIME%] aiusage: CLI not found at %AIUSAGE_CLI% >> "%AIUSAGE_LOG%"
  exit /b 1
)

rem Do not start a second one. A second serve does not fail - it finds the
rem port taken, retreats to 3848 and writes that into .serve-port, which
rem repoints every hook at the new instance while the old one keeps running.
rem This is the common case - it runs every 5 minutes - so it says nothing.
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":%AIUSAGE_PORT% " >nul 2>&1
if %ERRORLEVEL%==0 exit /b 0

rem serve removes .serve-port on a clean shutdown, so a file still sitting
rem here means the last one was killed rather than stopped.
if exist "%AIUSAGE_PORT_FILE%" echo [%DATE% %TIME%] aiusage: previous serve left .serve-port behind - it was killed, not stopped >> "%AIUSAGE_LOG%"

echo [%DATE% %TIME%] aiusage: starting serve >> "%AIUSAGE_LOG%"
node "%AIUSAGE_CLI%" serve >> "%AIUSAGE_LOG%" 2>&1
echo [%DATE% %TIME%] aiusage: serve exited with %ERRORLEVEL% >> "%AIUSAGE_LOG%"
'@
Set-Content -Path "$env:USERPROFILE\.aiusage\start-serve.cmd" -Value $cmd -Encoding ascii
```

`AIUSAGE_CLI` のパスを実際のチェックアウト先に書き換えること。

### 8. タスク登録

**登録には管理者権限が要るが、実行は通常権限で行われる。**

**管理者PowerShell**で実行する。非管理者では
`Register-ScheduledTask` が `アクセスが拒否されました (0x80070005)` で失敗する。
`-Principal` を省くと既定で S4U になり昇格が要る、というのが従来の
理解だったが、`-LogonType Interactive` を明示しても
アカウントによっては拒否される（ノートPCで実測）。

パスとユーザー名は**直書きする**。管理者セッションでは
`$env:USERPROFILE` が別ユーザーを指す場合がある。

```powershell
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "C:\Users\<ユーザー名>\.aiusage\start-serve.cmd"'
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$watch   = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$watch.Repetition.StopAtDurationEnd = $false
$settings  = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\<ユーザー名>" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName aiusage-serve -Action $action -Trigger $atLogon,$watch -Settings $settings -Principal $principal -Description "aiusage serve at logon, plus a 5-minute watchdog"
```

`-RunLevel Limited` なので、登録が管理者でも**タスク本体は通常権限で動く**。

`-AllowStartIfOnBatteries` と `-DontStopIfGoingOnBatteries` は
**ノートPCでは必須**。既定は「バッテリー駆動なら動かさない／止める」で、
付けないと電源を抜いた瞬間に serve が止まる。

検証（両方 False であること）:

```powershell
(Get-ScheduledTask -TaskName aiusage-serve).Triggers | ForEach-Object { "$($_.CimClass.CimClassName)  StopAtDurationEnd=$($_.Repetition.StopAtDurationEnd)  Interval=$($_.Repetition.Interval)" }
$p = (Get-ScheduledTask -TaskName aiusage-serve).Principal; "UserId=$($p.UserId)  LogonType=$($p.LogonType)  RunLevel=$($p.RunLevel)"
```

期待:

```
MSFT_TaskLogonTrigger  StopAtDurationEnd=False  Interval=
MSFT_TaskTimeTrigger   StopAtDurationEnd=False  Interval=PT5M
UserId=<PC名>\<ユーザー名>  LogonType=Interactive  RunLevel=Limited
```

`StopAtDurationEnd=True` は「繰り返し期間の終わりに実行中のタスクを止める」
設定で、常駐タスクに付けてよいものではない。
`New-ScheduledTaskTrigger -RepetitionInterval` は既定でこれを入れる。

### 9. 実地確認

**これが唯一のトークン検証手段。**

**確認の前に、その端末で Claude Code か Codex を1回動かして
レコードを作っておくとよい。** 送るレコードが1件も無いと
`runHubUpload` は `nothing_to_send` を返す。

なお heartbeat は0件でも送られるので、**レコードが無くても
ハブ側の `/api/health` の `spokes[]` には現れる。**
「届いているが送るものが無い」と「届いていない」は、
そちらで区別できる。

```powershell
schtasks /Run /TN aiusage-serve
Start-Sleep -Seconds 30
Get-Content "$env:USERPROFILE\.aiusage\serve.log" -Tail 14 -Encoding UTF8
```

`-Encoding UTF8` は必須。node は UTF-8 で書くので、
既定のコードページで読むと日本語が文字化けする。

| 出力 | 意味 |
|---|---|
| `[serve] uploaded N record(s) to the hub` | 成功 |
| `[serve] hub configured; nothing to upload yet` | 設定は正しい。まだ送るレコードが無いだけ |
| `[serve] hub upload failed: HTTP 401` | トークンが違う。手順3からやり直す |
| ログの時刻が更新されない | 古い serve が生きている。下記参照 |

最後にハブのダッシュボードを開き、デバイス数が増えていることを確認する。

### 10. 更新スクリプトを置く

以後この端末を更新する手段。**1台ごとに生成する。**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\write-update-cmd.ps1
```

`%USERPROFILE%\.aiusage\` に3つ書かれる。

| ファイル | 中身 |
|---|---|
| `aiusage-update.cmd` | 更新の全体。**順序が中身そのもの** |
| `aiusage-stop-serve.ps1` | ポートを持つプロセスを名指しで止める1手順 |
| `aiusage-restart-serve.ps1` | タスクを起動し、**ポートが戻ったかで判定する** |

**チェックアウトのパスは生成時に焼き込まれる。**
3台で場所が違う（`C:\Users\<ユーザー名>\Desktop\aiusage` と
`C:\Users\<ユーザー名>\aiusage`）ので、手で書き換える手順は残さない。
スクリプトは自分の置き場所からリポジトリの場所を知る。

**ハブでは `-WithWeb` を付ける。**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\write-update-cmd.ps1 -WithWeb
```

画面を配るのはハブだけ。spoke で web をビルドするのは、
誰も開かない画面のために毎回1分使うということ。
`dist/web` が無くても serve は警告して起動し、`/api` は動く。

以後の更新は、これ1つ。

```
%USERPROFILE%\.aiusage\aiusage-update.cmd
```

**中の順序を変えないこと。プル → ビルド → 停止 → 起動 → ログ。**
先に止めると、ビルドしている間この端末に serve が無い状態が続き、
**5分ごとのウォッチドッグが書きかけの `dist` の上で serve を起動する。**
（ノートPCで実際に起きた。）
プルかビルドが失敗したときは、動いている serve に手を付けずに終わる。

`git pull` は `--ff-only`。**移動前後のコミットを表示する。**

```
Updating: d8ddd58 -> 2749318   (5 commits)
```

何も来なかったときも1行出す（`Already up to date at <hash>.`）。
**出来事が起きなかったことも、走らせて確かめたかったことの答えである。**

動いている版と、チェックアウトされている版は**別の事実**であり、
ハブに報告されるのは前者（ビルド時に焼き込まれた版）。
上の表示は、その2つが揃ったことを確かめる場所でもある。
詳細は OPERATIONS.md「どの端末がどの版で動いているか」。

最後に25秒待ってログを表示する。ここまでの各手順が成功しても
serve が起動直後に落ちることはあり、それが出るのはログだけ。

## 踏んだ罠

### schtasks /End は node を道連れにしない

`/End` はタスク（cmd.exe）を終わらせるが、**子プロセスの node が生き残る**。
その状態で `/Run` しても、start-serve.cmd がポート3847の LISTENING を
検出して黙って終了するため、**設定を変えたのに古いプロセスが動き続ける**。
ログの時刻が更新されないのが唯一の症状。

対象を名指しで確認してから落とす:

```powershell
$targets = (Get-NetTCPConnection -LocalPort 3847 -State Listen).OwningProcess | Sort-Object -Unique
foreach ($procId in $targets) { Get-CimInstance Win32_Process -Filter "ProcessId=$procId" | Select-Object ProcessId, Name, CommandLine | Format-List }
```

`node.exe` で CommandLine に `aiusage\packages\cli\dist\index.js serve` が
入っていることを確認してから:

```powershell
foreach ($procId in $targets) { Stop-Process -Id $procId -Force }
Start-Sleep -Seconds 3
schtasks /Run /TN aiusage-serve
```

`Stop-Process -Name node` は使わないこと。他の node を巻き込む。

### 設定変更に serve の再起動が要るか

`loadConfig()` はディスクから毎回読むのでキャッシュはされない。
だが**レコード送信の間隔が20分**なので、確認を待たずに済ませるには
再起動する必要がある。agent イベントは即時なので影響を受けない。

### Codex の作業状態はハブに届かない（未解決）

Claude Code の状態は hook が送るのでハブに出る。
Codex には hook が無く、ローカル serve が rollout JSONL から導出して
`applyAgentEvents` でローカルDBに書く。**この経路は `hubForward` を
見ないので、Codex のセッションはその端末に留まる。**
`agent_sessions` を送る仕組みは今のところ存在しない
（`sendAgentEvent` の呼び出し元は hook クライアントだけ）。

したがって Codex 中心の端末では、ハブのダッシュボードに
使用量とコストは出るが、作業中／確認待ち／完了は出ない。
その端末のローカル serve では見えている。

### 価格未設定

新しい端末が知らないモデル（例 `gpt-5.6-sol`）を使っていると
`N 件のレコードに価格が設定されていません` が出て、$0 のまま
ハブへ送られる。cost は同期対象だが、ハブ側で価格表を更新して
`recalc` すれば後から直せるので、導入を止める理由にはならない。

## 端末を外す

```bash
node packages\cli\dist\index.js clear-hub
```

ハブに既に届いたレコードは消えない（D25: 削除は伝播しない）。

## 2026-09-02 職場PC：実際に通った順（ウィジェットまで）

上の 1〜10 は spoke を立てるところまでである。
以下は**その続きを、職場PCで実際に通った順で**書いたもの。
**通らなかったものも残す。** 回り道の理由が次の端末でも同じだから。

所要 約半日。うち大半は下の「BOM」である。

### 11-1. 更新スクリプトは PATH に無い

`~/.aiusage/aiusage-update.cmd` に置かれる。
**PowerShell は現在のフォルダも PATH に入れない**ので、名前だけでは動かない。

```powershell
& "$HOME\.aiusage\aiusage-update.cmd"
```

`-WithWeb` を付けるとダッシュボードも作り直す。

### 11-2. `aiusage` コマンドも PATH に無いことがある

pnpm のグローバル bin が PATH に入っていない端末がある。その場合は直接:

```powershell
node packages/cli/dist/index.js widget
```

`aiusage widget` が動くなら、`started from this checkout` と出るのが正しい。
`started from PATH` なら、そのチェックアウトのビルドではないものが動いている。

### 11-3. Electron の有無を root の `node_modules` で判定しないこと

pnpm はそこに置かない。**「入っていない」と誤判定して回り道をした。実際は入っていた。**
ウィジェットの package.json を起点に訊くこと:

```powershell
node -e "const {createRequire}=require('module'); console.log(createRequire('./packages/widget/package.json')('electron'))"
```

パスが出れば入っている。

### 11-4. config.json を PowerShell で書き換えないこと ★

**これが本日の最大の時間損失である。**

`Set-Content -Encoding UTF8` は **BOM を付ける。**
BOM 付きの config.json は `JSON.parse` が落ち、
`configuredHubUrl()` がそれを握り潰して既定値に落ちる。
結果、**エラーは1つも出ないまま、接続先だけが別物になる**（STATE.md の分類 (c)）。

どうしても書き換えるなら:

```powershell
[System.IO.File]::WriteAllText($p, $t)
```

これは BOM を付けない。あるいは node で書くこと。

先に確認する方法:

```powershell
(Get-Content ~/.aiusage/config.json -Encoding Byte -TotalCount 3) -join ','
```

`239,187,191` が出たら BOM が付いている。

### 11-5. パスワードを入れる

ウィジェットの歯車 → 「ハブ」→「ダッシュボードのパスワード」。
ハブの `config.credentials.dashboardPassword` と同じもの。

**2026-09-02 以前の版では、ここに入口が無かった**:
401 のときウィジェットは起動を拒否し、
「設定を開いてパスワードを入れてください」と言って終了していた。
**その設定は起動しないと開けない。** 現在は 401 では起動し、
設定パネルを開いた状態で出る（`unreachable` は従来どおり終了する）。

保存すると**再起動なしで**数字が出る。

### 11-6. 二重起動

**2026-09-03 以降は起きない。** ウィジェット自身が
`app.requestSingleInstanceLock()` を持ち、2つ目は即座に終了する。
OS が持つロックなので、**どの起動経路でも効き、古くならない。**

以前は CLI 側の `~/.aiusage/widget.pid` だけが見張っていた。
これには穴が2つあった:
ショートカットや electron の直接起動はそこを通らない。
そして**ファイルが消えると何も見張らなくなる**（クラッシュ後の通常の姿である）。

診断が要るときは:

```powershell
Get-Process electron | Select-Object Id,StartTime,Path
```

**プロセス数では数えられない**（1アプリで4プロセスある）。
StartTime も1アプリ内で1〜2秒ばらつくので、**厳密な組にはならない。**
実測: 1つのウィジェットで 0:03:34 ×3 と 0:03:35 ×1。
数分離れた塊が2つあれば二重起動である。
