# 現在の状態

最終更新: 2026-08-30（更新のたびに書き換える。追記ではなく置換）

## ロードマップ

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 起動確認 | 完了 |
| 2 | 日本語化 | 完了・main マージ済み |
| 3 | 端末識別 | 完了（device / deviceInstanceId） |
| 4 | Claude Code Hook 取り込み | 完了（8イベント、実データ確認済み） |
| 5 | Codex の状態取得 | 未着手 |
| 6-A | クォータ履歴・枯渇予測 | 完了（Codex で稼働中） |
| 6-B | 状態管理・作業時間計測 | 完了 |
| 7 | Discord 通知統合 | 完了（段階2 併走中） |
| 8 | Android/PWA 化 | 未着手 |

## スキーマ

- v13 quota_snapshots / quota_current / quota_windows
- v14 agent_sessions / agent_session_events / agent_session_spans
- v15 notifications / agent_sessions.escalation_level
- v16 v_agent_sessions の寛容な JOIN
- v17 records.session_id のバックフィル（作業中・未適用）

## 未解決の課題

1. Claude のクォータが取れていない。
   `~/.claude/.credentials.json` が存在しない（Claude Code Desktop が
   トークンをアプリ内に保持しているため）。
   解決策: `npm install -g @anthropic-ai/claude-code` → `claude` → `/login`。
   ユーザー操作待ち。実施すれば quota.ts は無改修で動く。
   statusLine 経由（案C）は Desktop で発火しないことを実測確認済み・行き止まり。
2. Gemini のクォータは未対応。Gemini CLI のトークン実績は probeGemini で取得可能。
   Gemini アプリ（Web）は消費率 API が非公開で取得手段なし。
3. ChatGPT Web / Gemini Web の会話利用は対象外（公開 API なし）。
   Claude.ai の Web 利用は Claude Code と 5h/7d 枠を共有するため、
   案A が通れば自動的に数字に含まれる。
4. Phase 8 の前提として、認証を既定必須にする必要がある。
   serve が 0.0.0.0 バインドかつ /api/summary と /api/quotas が無認証公開。
5. upstream の `extractSessionId`（parse.ts）が `'/'` でしか分割せず、
   Windows のパスで session_id がフルパスになる。v17 で対応中。
6. `device_instance_id` が全件 'unknown'。正規化は D1 のとおり単独では行わない。

## 稼働中のもの

- 本番 serve: ポート 3847（※ v17 適用作業のため一時停止中）
- クォータ取得: 5分間隔（Codex の five_hour / weekly_limit）
- Discord 通知: 段階2 併走中（既存 PowerShell と2通ずつ）
- hook: `~/.claude/settings.json` に8イベント登録済み
  （Stop / StopFailure / Notification / UserPromptSubmit /
    SessionStart / SessionEnd / PermissionRequest / PermissionDenied）

## バックアップ

- `~/.aiusage/backup-v12-20260829/` プロジェクト開始前
- `~/.aiusage/backup-v14-20260830/` 直近の安定状態（v16 取得後に削除予定）
- `~/.aiusage/backup-pre-claude-cli/` `~/.claude` 系（別目的・保持）
- `~/.claude/settings.json.pre-notify-hooks` hook 追記前（sha256 3c0ef1dbcf7bb8ee）
