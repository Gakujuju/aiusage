/*
 * This is the second set of translations in the repository.
 *
 * The dashboard has its own in packages/web/src/lib/i18n.js, with its own
 * key names and its own locale list. Adding a language means editing both,
 * and neither one knows the other exists. Recorded rather than merged: the
 * two have different lifetimes and different keys, and joining them is a
 * decision on its own. See STATE.md.
 */
export type Locale = 'en' | 'ja' | 'zh'

export interface Translations {
  /* ── The quota panel, which is what this widget is for ──────────── */
  quotaTitle: string
  tierFiveHour: string
  tierWeek: string
  resetsIn: (left: string) => string
  resetsUnknown: string
  /* Short units for a countdown, so the panel does not read as English. */
  unitDay: string
  unitHour: string
  unitMinute: string
  credInvalid: (tools: string) => string
  quotaStale: (age: string) => string
  tierHidden: (tiers: string) => string
  notificationsToggle: string
  hubSection: string
  hubUrlLabel: string
  hubPasswordLabel: string
  hubPasswordSet: string
  /** The hub is this machine, so its own password is being reused. */
  hubPasswordInherited: string
  /** Under an empty address box: what the blank actually resolves to. */
  hubUrlAuto: (url: string) => string
  /** Shown in the settings panel that opens by itself after a 401. */
  hubPasswordNeeded: string
  /** config.json is there and unreadable; the address below it is a guess. */
  configUnreadable: (detail: string) => string
  hubSave: string
  /* The widget itself is broken, which is not the same as the hub being down. */
  widgetNoBridge: string
  widgetStartFailed: (reason: string) => string
  widgetNoData: string
  hubUnreachable: (url: string) => string
  hubUnauthorized: (url: string) => string
  /** The four sizes, in the words the user used for them. */
  sizeSection: string
  sizeNormal: string
  sizeSmall: string
  sizeTiny: string
  sizeMicro: string
  /** Under the detail buttons while the smallest size is fixing them. */
  detailFixedAtMicro: string
  /* One choice of three, not a switch per element. */
  detail: string
  detailMeter: string
  detailPercent: string
  detailFull: string
  notShown: string
  noResetTime: string
  unknownTier: string
  tools: string
  nothingToShow: string
  showUsage: string
  /* ── What used to be the whole window ───────────────────────────── */
  today: string
  lastNDays: (n: number) => string
  tokenBreakdown: string
  tokenBreakdownToday: string
  trend: string
  topModel: string
  topTool: string
  sessions: string
  settings: string
  theme: string
  timeRange: string
  refreshInterval: string
  display: string
  currency: string
  exchangeRate: string
  exchangeRateUpdated: (time: string) => string
  exchangeRateUnavailable: string
  language: string
  showCost: string
  tokenBreakdownToggle: string
  activityChart: string
  syncedAt: (time: string) => string
  themeSystem: string
  themeLight: string
  themeDark: string
  themeKohaku: string
  themeMono: string
  showPanel: string
  openDashboard: string
  refresh: string
  quit: string
  close: string
  /** The switch for floating over other windows. */
  alwaysOnTop: string
  /** The fold control, which is not the close control. */
  collapse: string
  /** Title on the folded strip: how to get back. */
  expandHint: string
  installTitle: string
  installPreparing: string
  installInstalling: string
  installLaunching: string
  installDone: string
  installFailed: string
  setupTitle: string
  setupChecking: string
  setupParsing: string
  setupDone: string
  setupFailed: string
}

const en: Translations = {
  quotaTitle: 'Quota',
  tierFiveHour: '5 hours',
  tierWeek: 'Week',
  resetsIn: (left: string) => `${left} left`,
  resetsUnknown: 'no reset time',
  unitDay: 'd',
  unitHour: 'h',
  unitMinute: 'm',
  credInvalid: (tools: string) => `${tools}: credentials not valid`,
  quotaStale: (age: string) => `Last read ${age} ago — not updating`,
  tierHidden: (tiers: string) => `${tiers} is not shown: it reports no reset time`,
  notificationsToggle: 'Desktop notifications',
  hubSection: 'Hub',
  hubUrlLabel: 'Address',
  hubPasswordLabel: 'Dashboard password',
  hubPasswordSet: 'saved',
  hubPasswordInherited: "this machine's own",
  hubUrlAuto: (url: string) => `Empty means automatic - currently ${url}`,
  hubPasswordNeeded: 'The hub needs its dashboard password before this can show anything.',
  configUnreadable: (detail: string) =>
    `config.json could not be read, so this may be showing the wrong machine. ${detail}`,
  hubSave: 'Save',
  widgetNoBridge: 'The widget failed to load. Quit it from the tray and start it again.',
  widgetStartFailed: (reason: string) => `The widget failed to start: ${reason}`,
  widgetNoData: 'No reading yet.',
  hubUnreachable: (url: string) => `Cannot reach the hub at ${url}.`,
  hubUnauthorized: (url: string) => `The hub at ${url} rejected the password.`,
  sizeSection: 'Size',
  sizeNormal: 'Normal',
  sizeSmall: 'Small',
  sizeTiny: 'Tiny',
  sizeMicro: 'Micro',
  detailFixedAtMicro: 'Micro shows numbers only.',
  detail: 'Detail',
  detailMeter: 'Meter',
  detailPercent: '+ percent',
  detailFull: '+ time left',
  notShown: 'Not shown',
  noResetTime: 'reports no reset time',
  unknownTier: 'not a window this build knows',
  tools: 'Tools',
  nothingToShow: 'Nothing selected to show.',
  showUsage: 'Tokens and cost',
  today: 'Today',
  lastNDays: (n) => `Last ${n} days`,
  tokenBreakdown: 'Token breakdown',
  tokenBreakdownToday: 'Token breakdown (Today)',
  trend: 'Trend',
  topModel: 'Top Model',
  topTool: 'Top Tool',
  sessions: 'Sessions',
  settings: 'Settings',
  theme: 'Theme',
  timeRange: 'Time range',
  refreshInterval: 'Refresh interval',
  display: 'Display',
  currency: 'Currency',
  exchangeRate: 'Exchange rate',
  exchangeRateUpdated: (time) => `Updated ${time}`,
  exchangeRateUnavailable: 'Exchange rate unavailable',
  language: 'Language',
  showCost: 'Show cost',
  tokenBreakdownToggle: 'Token breakdown',
  activityChart: 'Activity chart',
  syncedAt: (time) => `Synced ${time}`,
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  themeKohaku: 'Amber',
  themeMono: 'Mono',
  showPanel: 'Show Panel',
  openDashboard: 'Open Dashboard',
  refresh: 'Refresh',
  quit: 'Quit',
  close: 'Close',
  alwaysOnTop: 'Keep on top',
  collapse: 'Fold to a strip',
  expandHint: 'Click to unfold - drag to move',
  installTitle: 'Dashboard Setup',
  installPreparing: 'Preparing...',
  installInstalling: 'Installing @juliantanx/aiusage...',
  installLaunching: 'Starting dashboard...',
  installDone: 'Done! Opening...',
  installFailed: 'Installation failed',
  setupTitle: 'First Time Setup',
  setupChecking: 'Checking CLI...',
  setupParsing: 'Parsing usage logs...',
  setupDone: 'Ready!',
  setupFailed: 'Setup failed',
}

const ja: Translations = {
  quotaTitle: '利用枠',
  tierFiveHour: '5時間',
  tierWeek: '週',
  resetsIn: (left: string) => `あと ${left}`,
  resetsUnknown: 'リセット時刻なし',
  unitDay: '日',
  unitHour: '時間',
  unitMinute: '分',
  credInvalid: (tools: string) => `${tools}：資格情報が無効です`,
  quotaStale: (age: string) => `${age}前の値 — 更新が止まっています`,
  tierHidden: (tiers: string) => `${tiers} は表示していません（リセット時刻を返さないため）`,
  notificationsToggle: 'デスクトップ通知',
  hubSection: 'ハブ',
  hubUrlLabel: 'アドレス',
  hubPasswordLabel: 'ダッシュボードのパスワード',
  hubPasswordSet: '保存済み',
  hubPasswordInherited: 'この端末のものを使用中',
  hubUrlAuto: (url: string) => `空欄なら自動 ── いまは ${url}`,
  hubPasswordNeeded: '数字を出すには、ハブのダッシュボードのパスワードが要ります。',
  configUnreadable: (detail: string) =>
    `config.json が読めません。別の端末の数字を出している可能性があります。${detail}`,
  hubSave: '保存',
  widgetNoBridge: 'ウィジェットの読み込みに失敗しました。トレイから終了して起動し直してください。',
  widgetStartFailed: (reason: string) => `ウィジェットの起動に失敗しました：${reason}`,
  widgetNoData: 'まだ値を受け取っていません。',
  hubUnreachable: (url: string) => `ハブに繋がりません（${url}）。`,
  hubUnauthorized: (url: string) => `ハブがパスワードを受け付けません（${url}）。`,
  sizeSection: '大きさ',
  sizeNormal: '普通',
  sizeSmall: '小',
  sizeTiny: '極小',
  sizeMicro: '最極小',
  detailFixedAtMicro: '最極小では数字だけになります。',
  detail: '詳しさ',
  detailMeter: 'メーターだけ',
  detailPercent: '＋ 割合',
  detailFull: '＋ リセットまで',
  notShown: '表示していないもの',
  noResetTime: 'リセット時刻を返さないため',
  unknownTier: 'この版が知らない枠のため',
  tools: 'ツール',
  nothingToShow: '表示するものがありません。',
  showUsage: 'トークンと費用',
  today: '今日',
  lastNDays: (n) => `過去${n}日`,
  tokenBreakdown: 'トークン内訳',
  tokenBreakdownToday: 'トークン内訳（今日）',
  trend: '推移',
  topModel: '最多モデル',
  topTool: '最多ツール',
  sessions: 'セッション',
  settings: '設定',
  theme: 'テーマ',
  timeRange: '期間',
  refreshInterval: '更新間隔',
  display: '表示',
  currency: '通貨',
  exchangeRate: '為替レート',
  exchangeRateUpdated: (time) => `${time} 更新`,
  exchangeRateUnavailable: '為替レートを取得できません',
  language: '言語',
  showCost: '費用を表示',
  tokenBreakdownToggle: 'トークン内訳',
  activityChart: '推移グラフ',
  syncedAt: (time) => `${time} 同期`,
  themeSystem: 'システム',
  themeLight: 'ライト',
  themeDark: 'ダーク',
  themeKohaku: '琥珀',
  themeMono: '白黒',
  showPanel: 'パネルを表示',
  openDashboard: 'ダッシュボードを開く',
  refresh: '更新',
  quit: '終了',
  close: '閉じる',
  alwaysOnTop: '常に最前面',
  collapse: '帯に折りたたむ',
  expandHint: 'クリックで戻す ── ドラッグで移動',
  installTitle: 'ダッシュボードの設定',
  installPreparing: '準備中...',
  installInstalling: '@juliantanx/aiusage をインストール中...',
  installLaunching: 'ダッシュボードを起動中...',
  installDone: '完了。開いています...',
  installFailed: 'インストールに失敗しました',
  setupTitle: '初回設定',
  setupChecking: 'CLI を確認中...',
  setupParsing: '使用ログを解析中...',
  setupDone: '準備できました',
  setupFailed: '設定に失敗しました',
}

const zh: Translations = {
  quotaTitle: '用量额度',
  tierFiveHour: '5 小时',
  tierWeek: '每周',
  resetsIn: (left: string) => `剩余 ${left}`,
  resetsUnknown: '无重置时间',
  unitDay: '天',
  unitHour: '小时',
  unitMinute: '分',
  credInvalid: (tools: string) => `${tools}：凭据无效`,
  quotaStale: (age: string) => `${age} 前读取 — 已停止更新`,
  tierHidden: (tiers: string) => `${tiers} 未显示：它不返回重置时间`,
  notificationsToggle: '桌面通知',
  hubSection: '中枢',
  hubUrlLabel: '地址',
  hubPasswordLabel: '仪表盘密码',
  hubPasswordSet: '已保存',
  hubPasswordInherited: '正在使用本机的密码',
  hubUrlAuto: (url: string) => `留空即自动 ── 当前为 ${url}`,
  hubPasswordNeeded: '需要输入枢纽的仪表盘密码后才能显示数据。',
  configUnreadable: (detail: string) =>
    `无法读取 config.json，显示的可能是另一台机器的数据。${detail}`,
  hubSave: '保存',
  widgetNoBridge: '挂件加载失败。请从托盘退出后重新启动。',
  widgetStartFailed: (reason: string) => `挂件启动失败：${reason}`,
  widgetNoData: '尚未收到数据。',
  hubUnreachable: (url: string) => `无法连接到中枢（${url}）。`,
  hubUnauthorized: (url: string) => `中枢拒绝了密码（${url}）。`,
  sizeSection: '大小',
  sizeNormal: '普通',
  sizeSmall: '小',
  sizeTiny: '极小',
  sizeMicro: '最小',
  detailFixedAtMicro: '最小尺寸只显示数字。',
  detail: '详细程度',
  detailMeter: '仅进度条',
  detailPercent: '＋ 百分比',
  detailFull: '＋ 剩余时间',
  notShown: '未显示的项目',
  noResetTime: '不返回重置时间',
  unknownTier: '此版本不认识的额度类型',
  tools: '工具',
  nothingToShow: '没有可显示的内容。',
  showUsage: '令牌与费用',
  today: '今日',
  lastNDays: (n) => `近 ${n} 天`,
  tokenBreakdown: 'Token 分布',
  tokenBreakdownToday: 'Token 分布 (今日)',
  trend: '趋势',
  topModel: '常用模型',
  topTool: '常用工具',
  sessions: '会话数',
  settings: '设置',
  theme: '主题',
  timeRange: '时间范围',
  refreshInterval: '刷新间隔',
  display: '显示',
  currency: '币种',
  exchangeRate: '汇率',
  exchangeRateUpdated: (time) => `更新于 ${time}`,
  exchangeRateUnavailable: '汇率不可用',
  language: '语言',
  showCost: '显示费用',
  tokenBreakdownToggle: 'Token 分布',
  activityChart: '活动图表',
  syncedAt: (time) => `同步于 ${time}`,
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  themeKohaku: '琥珀',
  themeMono: '黑白',
  showPanel: '显示面板',
  openDashboard: '打开仪表盘',
  refresh: '刷新',
  quit: '退出',
  close: '关闭',
  alwaysOnTop: '总在最前',
  collapse: '折叠为细条',
  expandHint: '点击展开 ── 拖动移动',
  installTitle: '仪表盘配置',
  installPreparing: '准备中...',
  installInstalling: '正在安装 @juliantanx/aiusage...',
  installLaunching: '正在启动仪表盘...',
  installDone: '完成！正在打开...',
  installFailed: '安装失败',
  setupTitle: '首次配置',
  setupChecking: '检测 CLI...',
  setupParsing: '解析使用日志...',
  setupDone: '就绪！',
  setupFailed: '配置失败',
}

const translations: Record<Locale, Translations> = { en, ja, zh }

export function t(locale: Locale): Translations {
  return translations[locale] ?? translations.en
}
