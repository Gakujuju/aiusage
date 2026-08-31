<script>
  import { onMount, onDestroy } from 'svelte'
  import { t } from '$lib/i18n.js'
  import { fetchConfig, saveConfig, fetchCredential, fetchDetectedTools, importKelivoBackup, notifySettingsUpdated, refreshExchangeRate, fetchSyncStatus, triggerSync, fetchCloudSyncStatus, sendNotificationTest, fetchPushStatus, savePushSubscription, deletePushSubscription, sendPushTest } from '$lib/api.js'
  import { pushSupport, subscribeToPush, localSubscriptionId, unsubscribeLocally } from '$lib/push.js'
  import { displayCurrency, exchangeRate } from '$lib/stores.js'
  import { splitSettingsSources } from '$lib/settings-sources.js'

  let loading = true
  /** @type {any} */
  let loadError = null

  // Unified form state for General + Data + Currency
  let general = {
    device: '', weekStart: 1, refreshInterval: '',
    retentionDays: '',
    displayCurrency: 'USD', exchangeRate: '',
  }
  /**
   * Which screens appear in the navigation.
   *
   * The server decides what may be hidden — home and settings are not on the
   * list, because settings is the only way back and home is where the
   * installed app starts. Stored as "visible" rather than "hidden" so the
   * checkboxes read the way they behave: ticked means you see it.
   *
   * @type {string[]}
   */
  let hideableRoutes = []
  /** @type {Record<string, boolean>} */
  let routeVisible = {}
  let navSaving = false
  let navSaved = false
  let navError = ''

  /**
   * Nav labels already exist for the sidebar; this reuses them.
   *
   * Typed as a record because the routes come from the server as plain
   * strings — without it, indexing is an implicit any.
   *
   * @type {Record<string, string>}
   */
  const ROUTE_LABEL_KEYS = {
    '/overview': 'nav.overview',
    '/tokens': 'nav.tokens',
    '/cost': 'nav.cost',
    '/models': 'nav.models',
    '/agents': 'nav.agents',
    '/sessions': 'nav.sessions',
    '/projects': 'nav.projects',
    '/tool-calls': 'nav.toolCalls',
    '/quotas': 'nav.quotas',
    '/notifications': 'nav.notifications',
    '/pricing': 'nav.pricing',
    '/leaderboard': 'nav.leaderboard',
    '/support': 'nav.support',
  }

  /** @param {any} cfg */
  function loadNavigation(cfg) {
    hideableRoutes = Array.isArray(cfg.hideableRoutes) ? cfg.hideableRoutes : []
    const hidden = new Set(cfg.ui?.hiddenRoutes ?? [])
    routeVisible = Object.fromEntries(hideableRoutes.map((route) => [route, !hidden.has(route)]))
  }

  async function saveNavigation() {
    navSaving = true; navError = ''
    try {
      await saveConfig({
        hiddenRoutes: hideableRoutes.filter((route) => !routeVisible[route]),
      })
      navSaved = true
      setTimeout(() => { navSaved = false }, 1500)
    } catch (e) {
      navError = e instanceof Error ? e.message : 'Failed to save'
    } finally {
      navSaving = false
    }
  }

  /** @type {any} */
  let detectedTools = []
  let showNotFound = false
  let currentPlatform = ''
  let currentHostname = ''
  let kelivoFileInput
  let kelivoImporting = false
  let kelivoImportError = ''
  /** @type {any} */
  let kelivoImportedCount = null
  /** @type {any} */
  let kelivoAddedCount = null

  const PLATFORM_LABEL = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

  $: sourceGroups = splitSettingsSources(detectedTools)
  $: manualImportTools = sourceGroups.manualImportTools
  $: activeTools = sourceGroups.activeDetectedTools
  $: notFoundTools = sourceGroups.notFoundDetectedTools

  // Sync form — credentialRef is derived automatically, never user-editable
  let syncData = { backend: '', repo: '', bucket: '', prefix: '', endpoint: '', region: 'auto' }
  let cloudLoggedIn = false
  let autoSyncEnabled = false
  let syncIntervalMinutes = '30'

  // Sync status
  /** @type {any} */
  let syncStatusData = null
  let syncRunning = false
  let cloudSyncAvailable = true
  let syncPollTimer = null

  $: currentSyncTarget = syncData.backend === 'cloud'
    ? 'cloud'
    : syncData.backend === 'github' && syncData.repo
      ? `github:${syncData.repo}`
      : syncData.backend === 's3' && syncData.bucket
        ? `s3:${syncData.bucket}`
        : ''
  $: displayedSyncStatus = !syncStatusData?.lastSyncTarget || !currentSyncTarget || syncStatusData.lastSyncTarget === currentSyncTarget
    ? syncStatusData
    : null

  // GitHub credential state
  let credentialKeys = []
  let ghToken = ''
  let ghTokenVisible = false
  let ghTokenLoading = false
  let ghTokenIsSet = false

  // S3 credential state — two separate credentials required by sync.ts
  let s3AkidValue = ''
  let s3AkidVisible = false
  let s3AkidLoading = false
  let s3AkidIsSet = false
  let s3SakValue = ''
  let s3SakVisible = false
  let s3SakLoading = false
  let s3SakIsSet = false

  // Track previous values to detect changes that invalidate cached credential reveals
  let prevBackend = ''
  let prevRepo = ''
  let prevBucket = ''

  let effectiveDeviceName = ''

  // Exchange rate cache
  let cachedRate = 0.137 // CNY→USD, internal direction
  let cachedRateFetchedAt = null
  let rateRefreshing = false

  $: cachedRateUsdToCny = cachedRate ? (1 / cachedRate).toFixed(2) : ''
  $: rateLastUpdated = cachedRateFetchedAt
    ? new Date(cachedRateFetchedAt).toLocaleString()
    : null
  $: kelivoTool = detectedTools.find(tool => tool.sourceKey === 'kelivo')
  $: kelivoLastImportedAt = typeof kelivoTool?.lastImportedAt === 'number'
    ? new Date(kelivoTool.lastImportedAt)
    : null
  $: kelivoStatus = kelivoLastImportedAt
    ? `${$t('settings.lastImported')} ${kelivoLastImportedAt.toLocaleString()}`
    : $t('settings.neverImported')

  // Per-section save state
  let generalSaving = false; let generalError = ''; let generalSaved = false
  let syncSaving = false;    let syncError = '';    let syncSaved = false
  let savedSyncSnapshot = ''
  $: syncDirty = JSON.stringify({
    backend: syncData.backend || '',
    repo: syncData.repo.trim(),
    bucket: syncData.bucket.trim(),
    prefix: syncData.prefix.trim(),
    endpoint: syncData.endpoint.trim(),
    region: syncData.region.trim(),
    autoSyncEnabled,
    syncIntervalMinutes: autoSyncEnabled ? String(syncIntervalMinutes) : '',
    ghTokenPending: Boolean(ghToken),
    s3AkidPending: Boolean(s3AkidValue),
    s3SakPending: Boolean(s3SakValue),
  }) !== savedSyncSnapshot

  // Credential key derivation — must match sync.ts createBackend()
  function ghKey(repo)    { return `github/${repo}/token` }
  function s3AkidKey(bucket) { return `s3/${bucket}/accessKeyId` }
  function s3SakKey(bucket)  { return `s3/${bucket}/secretAccessKey` }
  function hasCredentialKey(key) { return credentialKeys.includes(key) }
  function inferGithubRepoFromKeys(keys) {
    const key = keys.find(k => /^github\/[^/]+\/[^/]+\/token$/.test(k))
    return key ? key.replace(/^github\//, '').replace(/\/token$/, '') : ''
  }
  function inferS3BucketFromKeys(keys) {
    const key = keys.find(k => /^s3\/[^/]+\/accessKeyId$/.test(k))
    return key ? key.replace(/^s3\//, '').replace(/\/accessKeyId$/, '') : ''
  }
  function syncSnapshot() {
    return JSON.stringify({
      backend: syncData.backend || '',
      repo: syncData.repo.trim(),
      bucket: syncData.bucket.trim(),
      prefix: syncData.prefix.trim(),
      endpoint: syncData.endpoint.trim(),
      region: syncData.region.trim(),
      autoSyncEnabled,
      syncIntervalMinutes: autoSyncEnabled ? String(syncIntervalMinutes) : '',
      ghTokenPending: Boolean(ghToken),
      s3AkidPending: Boolean(s3AkidValue),
      s3SakPending: Boolean(s3SakValue),
    })
  }

  function resetAllCredentialState() {
    ghToken = ''; ghTokenVisible = false; ghTokenLoading = false; ghTokenIsSet = false
    s3AkidValue = ''; s3AkidVisible = false; s3AkidLoading = false; s3AkidIsSet = false
    s3SakValue = ''; s3SakVisible = false; s3SakLoading = false; s3SakIsSet = false
  }

  function onBackendChange() {
    if (syncData.backend === 'github' && !syncData.repo) {
      syncData.repo = inferGithubRepoFromKeys(credentialKeys)
    }
    if (syncData.backend === 's3' && !syncData.bucket) {
      syncData.bucket = inferS3BucketFromKeys(credentialKeys)
    }
    ghToken = ''; ghTokenVisible = false; ghTokenLoading = false
    s3AkidValue = ''; s3AkidVisible = false; s3AkidLoading = false
    s3SakValue = ''; s3SakVisible = false; s3SakLoading = false
    ghTokenIsSet = !!(syncData.repo && hasCredentialKey(ghKey(syncData.repo)))
    s3AkidIsSet = !!(syncData.bucket && hasCredentialKey(s3AkidKey(syncData.bucket)))
    s3SakIsSet = !!(syncData.bucket && hasCredentialKey(s3SakKey(syncData.bucket)))
    if (syncData.backend === 's3' && !syncData.region) syncData.region = 'auto'
    prevBackend = syncData.backend
    prevRepo = syncData.repo
    prevBucket = syncData.bucket
  }

  function onRepoChange() {
    if (syncData.repo !== prevRepo) {
      ghToken = ''; ghTokenVisible = false; ghTokenLoading = false; ghTokenIsSet = false
      prevRepo = syncData.repo
    }
  }

  function onBucketChange() {
    if (syncData.bucket !== prevBucket) {
      s3AkidValue = ''; s3AkidVisible = false; s3AkidLoading = false; s3AkidIsSet = false
      s3SakValue = ''; s3SakVisible = false; s3SakLoading = false; s3SakIsSet = false
      prevBucket = syncData.bucket
    }
  }

  onMount(async () => {
    try {
      const [cfg, toolsResult] = await Promise.all([fetchConfig(), fetchDetectedTools()])
      general = {
        device: cfg.device ?? '',
        weekStart: cfg.weekStart ?? 1,
        refreshInterval: cfg.refreshInterval != null ? String(cfg.refreshInterval) : '',
        retentionDays: cfg.retentionDays != null ? String(cfg.retentionDays) : '',
        displayCurrency: cfg.displayCurrency || 'USD',
        exchangeRate: cfg.exchangeRate ? (1 / cfg.exchangeRate).toFixed(4) : '',
      }
      loadNotifications(cfg)
      loadNavigation(cfg)
      detectedTools = toolsResult.tools ?? []
      currentPlatform = cfg.platform ?? ''
      currentHostname = cfg.hostname ?? ''
      const keys = cfg.credentialKeys ?? []
      credentialKeys = keys
      const inferredGithubRepo = inferGithubRepoFromKeys(keys)
      const inferredS3Bucket = inferS3BucketFromKeys(keys)
      syncData = {
        backend: cfg.sync?.backend ?? (inferredGithubRepo ? 'github' : ''),
        repo: cfg.sync?.repo ?? inferredGithubRepo,
        bucket: cfg.sync?.bucket ?? inferredS3Bucket,
        prefix: cfg.sync?.prefix ?? '',
        endpoint: cfg.sync?.endpoint ?? '',
        region: cfg.sync?.backend === 's3' ? (cfg.sync?.region ?? 'auto') : (cfg.sync?.region ?? ''),
      }
      prevBackend = syncData.backend
      prevRepo = syncData.repo
      prevBucket = syncData.bucket
      cloudLoggedIn = Boolean(cfg.loggedIn)

      const si = cfg.syncInterval
      if (si && si > 0) {
        autoSyncEnabled = true
        syncIntervalMinutes = String(Math.round(si / 60000))
      }

      // Check both the structured key (new UI) and credentialRef (old init command)
      const oldRef = cfg.sync?.credentialRef ?? ''
      ghTokenIsSet = !!(syncData.repo && (keys.includes(ghKey(syncData.repo)) || (oldRef && keys.includes(oldRef))))
      s3AkidIsSet  = !!(syncData.bucket && keys.includes(s3AkidKey(syncData.bucket)))
      s3SakIsSet   = !!(syncData.bucket && keys.includes(s3SakKey(syncData.bucket)))
      savedSyncSnapshot = syncSnapshot()

      effectiveDeviceName = cfg.device || currentHostname || 'hostname'

      if (cfg.exchangeRateCache?.CNY_USD) {
        cachedRate = cfg.exchangeRateCache.CNY_USD
        cachedRateFetchedAt = cfg.exchangeRateCache.fetchedAt
      }

      loadSyncStatusData()
      // Reads only. The permission prompt lives behind the button in the
      // Web Push card, never here.
      loadPushState()
      if (cfg.siteUrl) {
        fetchCloudSyncStatus(cfg.siteUrl).then(s => { cloudSyncAvailable = s.enabled })
      }
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load'
    } finally {
      loading = false
    }
  })

  async function loadSyncStatusData() {
    try {
      const data = await fetchSyncStatus()
      syncStatusData = data.status
      syncRunning = Boolean(syncStatusData?.isRunning)
    } catch {
      syncStatusData = null
    }
  }

  async function handleSyncFromSettings() {
    syncRunning = true
    try {
      await triggerSync()
      startSyncPolling()
    } catch {
      syncRunning = false
      await loadSyncStatusData()
    }
  }

  function startSyncPolling() {
    stopSyncPolling()
    syncPollTimer = setInterval(async () => {
      await loadSyncStatusData()
      if (!syncStatusData?.isRunning) {
        stopSyncPolling()
        syncRunning = false
      }
    }, 800)
  }

  function stopSyncPolling() {
    if (syncPollTimer) {
      clearInterval(syncPollTimer)
      syncPollTimer = null
    }
  }

  function formatSyncTime(ts) {
    if (!ts) return $t('settings.syncNever')
    const d = new Date(ts)
    return d.toLocaleString()
  }

  async function saveGeneral() {
    generalSaving = true; generalError = ''
    try {
      // Convert user-facing USD→CNY to internal CNY→USD
      const userRate = general.exchangeRate ? Number(general.exchangeRate) : 0
      const internalRate = userRate > 0 ? 1 / userRate : null

      await saveConfig({
        device: general.device || null,
        weekStart: Number(general.weekStart),
        refreshInterval: general.refreshInterval ? Number(general.refreshInterval) : null,
        retentionDays: general.retentionDays ? Number(general.retentionDays) : null,
        displayCurrency: general.displayCurrency,
        exchangeRate: internalRate,
      })
      notifySettingsUpdated({
        refreshInterval: general.refreshInterval ? Number(general.refreshInterval) : null,
        device: general.device || null,
      })
      effectiveDeviceName = general.device || currentHostname || 'hostname'
      displayCurrency.set(general.displayCurrency)
      if (internalRate) {
        exchangeRate.set(internalRate)
      } else {
        exchangeRate.set(cachedRate)
      }
      generalSaved = true
      setTimeout(() => { generalSaved = false }, 2000)
    } catch (e) {
      generalError = e instanceof Error ? e.message : 'Save failed'
    } finally {
      generalSaving = false
    }
  }

  async function saveSync() {
    syncSaving = true; syncError = ''
    try {
      syncData.repo = syncData.repo.trim()
      syncData.bucket = syncData.bucket.trim()
      syncData.prefix = syncData.prefix.trim()
      syncData.endpoint = syncData.endpoint.trim()
      syncData.region = syncData.region.trim()

      if (syncData.backend === 'github') {
        if (!syncData.repo) throw new Error($t('settings.syncRepoRequired'))
        if (!/^[^/\s]+\/[^/\s]+$/.test(syncData.repo)) throw new Error($t('settings.syncRepoInvalid'))
        if (!ghToken && !ghTokenIsSet) throw new Error($t('settings.syncGithubTokenRequired'))
      } else if (syncData.backend === 's3') {
        if (!syncData.bucket) throw new Error($t('settings.syncBucketRequired'))
        if (!s3AkidValue && !s3AkidIsSet) throw new Error($t('settings.syncS3AccessKeyRequired'))
        if (!s3SakValue && !s3SakIsSet) throw new Error($t('settings.syncS3SecretKeyRequired'))
      }

      // Build the sync config payload with auto-derived credentialRef
      let syncPayload = null
      if (syncData.backend === 'cloud') {
        syncPayload = { backend: 'cloud' }
      } else if (syncData.backend === 'github' && syncData.repo) {
        syncPayload = {
          backend: 'github',
          repo: syncData.repo,
          credentialRef: ghKey(syncData.repo),
        }
      } else if (syncData.backend === 's3' && syncData.bucket) {
        syncPayload = {
          backend: 's3',
          bucket: syncData.bucket,
          prefix: syncData.prefix || '',
          endpoint: syncData.endpoint || '',
          region: syncData.region || 'auto',
          credentialRef: s3AkidKey(syncData.bucket),
        }
      }

      // Build credentials — use the same keys sync.ts reads
      const credentials = {}
      if (syncData.backend === 'github' && syncData.repo && ghToken) {
        credentials[ghKey(syncData.repo)] = ghToken
      }
      if (syncData.backend === 's3' && syncData.bucket) {
        if (s3AkidValue) credentials[s3AkidKey(syncData.bucket)] = s3AkidValue
        if (s3SakValue)  credentials[s3SakKey(syncData.bucket)]  = s3SakValue
      }

      const syncIntervalMs = autoSyncEnabled && syncIntervalMinutes
        ? Number(syncIntervalMinutes) * 60000
        : null

      const payload = { sync: syncPayload, syncInterval: syncIntervalMs }
      if (Object.keys(credentials).length > 0) payload.credentials = credentials

      await saveConfig(payload)

      // Update isSet flags and clear entered values (don't expose creds in memory longer than needed)
      if (syncData.backend === 'github') {
        if (ghToken) {
          credentialKeys = Array.from(new Set([...credentialKeys, ghKey(syncData.repo)]))
          ghTokenIsSet = true; ghToken = ''; ghTokenVisible = false
        }
      } else if (syncData.backend === 's3') {
        if (s3AkidValue) {
          credentialKeys = Array.from(new Set([...credentialKeys, s3AkidKey(syncData.bucket)]))
          s3AkidIsSet = true; s3AkidValue = ''; s3AkidVisible = false
        }
        if (s3SakValue) {
          credentialKeys = Array.from(new Set([...credentialKeys, s3SakKey(syncData.bucket)]))
          s3SakIsSet  = true; s3SakValue  = ''; s3SakVisible  = false
        }
      }

      prevBackend = syncData.backend
      prevRepo    = syncData.repo
      prevBucket  = syncData.bucket

      savedSyncSnapshot = syncSnapshot()
      syncSaved = true
      setTimeout(() => { syncSaved = false }, 2000)
      await loadSyncStatusData()
      return true
    } catch (e) {
      syncError = e instanceof Error ? e.message : 'Save failed'
      return false
    } finally {
      syncSaving = false
    }
  }

  async function handleRefreshRate() {
    rateRefreshing = true
    try {
      const result = await refreshExchangeRate()
      cachedRate = result.rate
      cachedRateFetchedAt = result.fetchedAt
      // Update store if no manual override
      if (!general.exchangeRate) {
        exchangeRate.set(result.rate)
      }
    } catch (e) {
      generalError = e instanceof Error ? e.message : 'Refresh failed'
    } finally {
      rateRefreshing = false
    }
  }

  function triggerKelivoImport() {
    kelivoImportError = ''
    kelivoFileInput?.click()
  }

  function mergeKelivoImportMetadata(tools, result) {
    if (typeof result?.lastImportedAt !== 'number') return tools
    return tools.map((tool) => tool.sourceKey === 'kelivo'
      ? { ...tool, lastImportedAt: result.lastImportedAt }
      : tool)
  }

  async function handleKelivoFileChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.name !== 'chats.json' && !file.name.toLowerCase().endsWith('.zip')) {
      kelivoImportError = $t('settings.kelivoInvalidFile')
      return
    }

    kelivoImporting = true
    kelivoImportError = ''
    kelivoImportedCount = null
    kelivoAddedCount = null
    try {
      const result = await importKelivoBackup(file)
      kelivoImportedCount = result.imported ?? 0
      kelivoAddedCount = result.added ?? null
      let nextTools = detectedTools
      try {
        const toolsResult = await fetchDetectedTools()
        nextTools = toolsResult.tools ?? detectedTools
      } catch {}
      detectedTools = mergeKelivoImportMetadata(nextTools, result)
      notifySettingsUpdated({ importedTool: 'kelivo' })
    } catch (e) {
      kelivoImportError = e instanceof Error ? e.message : $t('settings.kelivoImportFailed')
    } finally {
      kelivoImporting = false
    }
  }

  // Per-credential toggle helpers
  async function toggleGhToken() {
    syncError = ''
    syncData.repo = syncData.repo.trim()
    if (!syncData.repo) {
      syncError = $t('settings.syncRepoRequired')
      return
    }
    if (ghTokenVisible) { ghTokenVisible = false; return }
    if (ghToken) { ghTokenVisible = true; return }
    ghTokenLoading = true
    try {
      const data = await fetchCredential(ghKey(syncData.repo))
      ghToken = data.value ?? ''
      ghTokenVisible = true
      ghTokenIsSet = !!ghToken
    } catch (e) {
      syncError = e instanceof Error ? e.message : 'Failed to load credential'
    } finally {
      ghTokenLoading = false
    }
  }

  async function toggleS3Akid() {
    syncError = ''
    syncData.bucket = syncData.bucket.trim()
    if (!syncData.bucket) {
      syncError = $t('settings.syncBucketRequired')
      return
    }
    if (s3AkidVisible) { s3AkidVisible = false; return }
    if (s3AkidValue) { s3AkidVisible = true; return }
    s3AkidLoading = true
    try {
      const data = await fetchCredential(s3AkidKey(syncData.bucket))
      s3AkidValue = data.value ?? ''
      s3AkidVisible = true
      s3AkidIsSet = !!s3AkidValue
    } catch (e) {
      syncError = e instanceof Error ? e.message : 'Failed to load credential'
    } finally {
      s3AkidLoading = false
    }
  }

  async function toggleS3Sak() {
    syncError = ''
    syncData.bucket = syncData.bucket.trim()
    if (!syncData.bucket) {
      syncError = $t('settings.syncBucketRequired')
      return
    }
    if (s3SakVisible) { s3SakVisible = false; return }
    if (s3SakValue) { s3SakVisible = true; return }
    s3SakLoading = true
    try {
      const data = await fetchCredential(s3SakKey(syncData.bucket))
      s3SakValue = data.value ?? ''
      s3SakVisible = true
      s3SakIsSet = !!s3SakValue
    } catch (e) {
      syncError = e instanceof Error ? e.message : 'Failed to load credential'
    } finally {
      s3SakLoading = false
    }
  }

  onDestroy(() => {
    stopSyncPolling()
  })

  function btnLabel(saving, saved, t_save, t_saved) {
    if (saving) return '...'
    if (saved) return t_saved
    return t_save
  }

  // ── Notifications ───────────────────────────────────────────────────
  //
  // The webhook is deliberately absent from this form. It is a secret, this
  // page may be served on a LAN once 8-B lands, and `aiusage notify-test
  // --set-webhook` already reads it from stdin so it never reaches shell
  // history. All the UI does is report whether one is configured.

  /** Statuses the notifier knows how to announce, in the order they matter. */
  /** The same names /quotas and /agents use for the tools. */
  const TOOL_LABEL_KEYS = {
    'claude-code': 'quotas.toolLabels.claude-code',
    codex: 'quotas.toolLabels.codex',
  }

  /** @param {string} tool */
  function toolLabelFor(tool) {
    const key = TOOL_LABEL_KEYS[tool]
    return key ? $t(key) : tool
  }

  /**
   * Statuses the notifier can announce, and what it does when unset.
   *
   * Mirrors core's DEFAULT_NOTIFICATION_EVENTS. Reading every unset key as
   * "on" showed running and idle as enabled when they are not — and saving
   * the form then actually turned them on, so opening this page and pressing
   * Save would have subscribed the reader to the two noisiest events without
   * ever saying so.
   */
  const NOTIFY_EVENT_DEFAULTS = {
    waiting_for_permission: true,
    waiting_for_user: true,
    failed: true,
    completed: true,
    running: false,
    idle: false,
  }
  const NOTIFY_EVENTS = Object.keys(NOTIFY_EVENT_DEFAULTS)

  /** @type {any} */
  let notif = {
    enabled: false,
    prefix: '',
    notifierDevice: true,
    includeAssistantMessage: false,
    events: {},
    tools: {},
    thresholds: '',
    quietStart: '',
    quietEnd: '',
    quietHoursAllow: {},
    escalation: '',
  }
  let notifSaving = false
  let notifSaved = false
  let notifError = ''
  let webhookConfigured = false
  let testSending = false
  /** @type {string} */
  let testResult = ''

  /** Tools that could be announced: whatever config knows, plus what it can. */
  const KNOWN_TOOLS = ['claude-code', 'codex']

  /** @param {any} cfg */
  function loadNotifications(cfg) {
    const n = cfg?.notifications ?? {}
    webhookConfigured = cfg?.notificationWebhookConfigured === true

    const events = {}
    for (const key of NOTIFY_EVENTS) {
      // Unset means that event's default, not "on": an untouched config has
      // to show the behaviour it actually has.
      events[key] = n.events?.[key] ?? NOTIFY_EVENT_DEFAULTS[key]
    }

    // Driven by what came back rather than a fixed list, so a tool added to
    // the config later appears here without an edit.
    const tools = {}
    for (const key of [...new Set([...KNOWN_TOOLS, ...Object.keys(n.tools ?? {})])]) {
      tools[key] = n.tools?.[key] !== false
    }

    const allow = {}
    const allowList = n.quietHoursAllow ?? ['waiting_for_permission', 'failed']
    for (const key of NOTIFY_EVENTS) allow[key] = allowList.includes(key)

    notif = {
      enabled: n.enabled === true,
      // Unset means on, so a config that predates channels keeps sending to
      // Discord exactly as it did.
      channelDiscord: n.channels?.discord !== false,
      // Off unless switched on: the server treats it the same way, and a
      // toggle showing "on" for a channel with no keys and no devices would
      // be describing something that cannot happen.
      channelWebpush: n.channels?.webpush === true,
      prefix: n.prefix ?? '',
      notifierDevice: n.notifierDevice !== false,
      includeAssistantMessage: n.includeAssistantMessage === true,
      events,
      tools,
      thresholds: (n.quota?.thresholds ?? [80, 95, 100]).join(', '),
      quietStart: n.quietHours?.start ?? '',
      quietEnd: n.quietHours?.end ?? '',
      quietHoursAllow: allow,
      // Stored in milliseconds; shown in minutes, because that is how a
      // person thinks about "re-tell me in 10 minutes".
      escalation: (n.escalation?.waiting_for_permission ?? [600000, 1800000])
        .map((/** @type {number} */ ms) => Math.round(ms / 60000)).join(', '),
    }
  }

  /** "80, 95, 100" → [80, 95, 100]; anything unparseable is dropped. */
  function parseNumberList(value) {
    return String(value ?? '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  }

  async function saveNotifications() {
    notifSaving = true; notifError = ''
    try {
      const events = {}
      for (const key of NOTIFY_EVENTS) events[key] = notif.events[key] === true
      const tools = {}
      for (const key of Object.keys(notif.tools)) tools[key] = notif.tools[key] === true

      const quietHours = notif.quietStart && notif.quietEnd
        ? { start: notif.quietStart, end: notif.quietEnd }
        : undefined

      // Sent whole, not piecemeal: the server merges the notifications object
      // shallowly, so a partial `events` would replace the rest of it.
      await saveConfig({
        notifications: {
          enabled: notif.enabled === true,
          channels: { discord: notif.channelDiscord === true, webpush: notif.channelWebpush === true },
          prefix: notif.prefix || undefined,
          notifierDevice: notif.notifierDevice === true,
          includeAssistantMessage: notif.includeAssistantMessage === true,
          events,
          tools,
          quota: { thresholds: parseNumberList(notif.thresholds) },
          quietHours,
          quietHoursAllow: NOTIFY_EVENTS.filter((k) => notif.quietHoursAllow[k]),
          escalation: {
            waiting_for_permission: parseNumberList(notif.escalation).map((m) => m * 60000),
          },
        },
      })
      notifSaved = true
      setTimeout(() => { notifSaved = false }, 2000)
    } catch (e) {
      notifError = e instanceof Error ? e.message : 'Failed to save'
    } finally {
      notifSaving = false
    }
  }

  /**
   * Web Push.
   *
   * Nothing here runs on mount except reading the server's state and the
   * permission this browser already granted. Reading Notification.permission
   * does not prompt; requesting it does, and that only happens under the
   * subscribe button.
   */
  /** @type {any} */
  let push = { publicKey: null, configured: false, enabled: false, subject: '', subscriptions: [] }
  /** @type {'default'|'granted'|'denied'} */
  let pushPermission = 'default'
  let pushSupported = false
  let pushStandalone = false
  /** True when this very browser holds a subscription, not just some device. */
  let pushSubscribedHere = false
  /** @type {string|null} Which row in the list is this browser. */
  let pushLocalId = null
  let pushBusy = false
  /** @type {string} */
  let pushError = ''
  /** @type {string} */
  let pushResult = ''
  /** @type {string} */
  let pushLabel = ''
  /** @type {string} */
  let vapidSubject = ''

  async function loadPushState() {
    const support = pushSupport()
    pushSupported = support.supported
    pushPermission = /** @type {any} */ (support.permission)
    pushStandalone = support.standalone === true
    if (!pushSupported) return
    try {
      push = await fetchPushStatus()
      vapidSubject = push.subject ?? ''
      // "This device" means the server has the row this browser's endpoint
      // maps to — a local subscription the server never received, or one it
      // has since pruned as gone, is not subscribed in any useful sense.
      pushLocalId = await localSubscriptionId()
      pushSubscribedHere = pushLocalId != null
        && push.subscriptions.some((/** @type {any} */ s) => s.id === pushLocalId)
    } catch (e) {
      pushError = e instanceof Error ? e.message : 'Failed'
    }
  }

  /**
   * Called from a click, and only from a click.
   *
   * A permission prompt raised on page load is answered "block" often enough
   * that it is worth treating as the failure case it is: once denied, the
   * site cannot ask again.
   */
  async function enablePush() {
    pushBusy = true; pushError = ''; pushResult = ''
    try {
      if (!push.publicKey) throw new Error($t('settings.push.errorNoKey'))
      const subscription = await subscribeToPush(push.publicKey)
      await savePushSubscription(subscription, pushLabel.trim())
      pushPermission = 'granted'
      pushLabel = ''
      push = await fetchPushStatus()
      pushLocalId = await localSubscriptionId()
      pushSubscribedHere = true
      pushResult = $t('settings.push.subscribed')
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      pushError = reason === 'denied'
        ? $t('settings.push.errorDenied')
        : reason === 'dismissed'
          ? $t('settings.push.errorDismissed')
          : reason === 'unsupported'
            ? $t('settings.push.errorUnsupported')
            : reason
    } finally {
      pushBusy = false
    }
  }

  /** @param {string} id */
  async function removePushDevice(id) {
    pushBusy = true; pushError = ''; pushResult = ''
    try {
      await deletePushSubscription(id)
      // Deleting this browser's own row also releases the browser's
      // subscription. Leaving it in place would keep a live endpoint that
      // nothing sends to, and the next subscribe would silently reuse it.
      if (id === pushLocalId) {
        await unsubscribeLocally()
        pushLocalId = null
        pushSubscribedHere = false
      }
      push = await fetchPushStatus()
    } catch (e) {
      pushError = e instanceof Error ? e.message : 'Failed'
    } finally {
      pushBusy = false
    }
  }

  /**
   * The RFC 8292 contact, saved on its own.
   *
   * Separate from the notifications form because it is not a preference: the
   * push service is told this on every delivery, so it leaves the machine in
   * a way none of the other settings do.
   */
  async function saveVapidSubject() {
    pushBusy = true; pushError = ''; pushResult = ''
    try {
      await saveConfig({ vapidSubject: vapidSubject.trim() })
      push = await fetchPushStatus()
      vapidSubject = push.subject ?? ''
      pushResult = $t('settings.saved')
    } catch (e) {
      pushError = e instanceof Error ? e.message : 'Failed'
    } finally {
      pushBusy = false
    }
  }

  async function sendPushTestMessage() {
    pushBusy = true; pushError = ''; pushResult = ''
    try {
      const result = await sendPushTest()
      pushResult = result?.enqueued
        ? $t('settings.push.testQueued')
        : $t('settings.push.testSkipped')
    } catch (e) {
      pushError = e instanceof Error ? e.message : 'Failed'
    } finally {
      pushBusy = false
    }
  }

  async function sendTestNotification() {
    testSending = true; testResult = ''
    try {
      const result = await sendNotificationTest()
      testResult = result?.enqueued
        ? $t('settings.notifications.testQueued')
        : $t('settings.notifications.testSkipped')
    } catch (e) {
      testResult = e instanceof Error ? e.message : 'Failed'
    } finally {
      testSending = false
    }
  }
</script>

<svelte:head>
  <title>{$t('settings.title')} — AIUsage</title>
</svelte:head>

<div class="page-header">
  <h1>{$t('settings.title')}</h1>
</div>

{#if loading}
  <div class="state-msg">{$t('common.loading')}</div>
{:else if loadError}
  <div class="state-msg error">{loadError}</div>
{:else}
  <div class="sections">

    <!-- General (merged: general + data + currency) -->
    <div class="card">
      <div class="group-title">{$t('settings.general')}</div>
      <div class="fields">
        <div class="field">
          <label class="field-label" for="field-device">{$t('settings.device')}</label>
          <input id="field-device" type="text" bind:value={general.device} class="field-input" placeholder={currentHostname || 'hostname'} />
          <div class="field-hint">{$t('settings.deviceHint')}</div>
        </div>
        <div class="field">
          <label class="field-label" for="field-week-start">{$t('settings.weekStart')}</label>
          <select id="field-week-start" bind:value={general.weekStart} class="field-input">
            <option value={0}>{$t('settings.weekStartSunday')}</option>
            <option value={1}>{$t('settings.weekStartMonday')}</option>
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="field-refresh-interval">{$t('settings.refreshInterval')}</label>
          <input id="field-refresh-interval" type="number" bind:value={general.refreshInterval} class="field-input" placeholder="e.g. 30000" min="1000" />
        </div>
        <div class="field">
          <label class="field-label" for="field-retention-days">{$t('settings.retentionDays')}</label>
          <input id="field-retention-days" type="number" bind:value={general.retentionDays} class="field-input" placeholder={$t('settings.retentionPlaceholder')} min="0" />
          <div class="field-hint">{$t('settings.retentionHint')}</div>
        </div>
        <div class="field">
          <label class="field-label" for="field-display-currency">{$t('settings.displayCurrency')}</label>
          <select id="field-display-currency" bind:value={general.displayCurrency} class="field-input">
            <option value="USD">USD ($)</option>
            <option value="CNY">CNY (¥)</option>
          </select>
        </div>
        {#if general.displayCurrency === 'CNY'}
          <div class="field">
            <label class="field-label" for="field-exchange-rate">
              {$t('settings.exchangeRate')} (1 USD = ? CNY)
            </label>
            <div class="rate-row">
              <input id="field-exchange-rate" type="number" step="0.01" min="0"
                bind:value={general.exchangeRate} class="field-input"
                placeholder="Auto: {cachedRateUsdToCny}" />
              <button type="button" class="btn-ghost" on:click={handleRefreshRate}
                disabled={rateRefreshing}>
                {rateRefreshing ? '...' : $t('settings.refreshRate')}
              </button>
            </div>
            <div class="field-hint">
              {$t('settings.exchangeRateHint')}
              {#if rateLastUpdated}
                <span class="rate-time">{$t('settings.rateLastUpdated')}: {rateLastUpdated}</span>
              {/if}
            </div>
          </div>
        {/if}
      </div>
      {#if generalError}<p class="section-error">{generalError}</p>{/if}
      <div class="section-footer">
        <button class="btn-save" class:saved={generalSaved} on:click={saveGeneral} disabled={generalSaving}>
          {btnLabel(generalSaving, generalSaved, $t('settings.save'), $t('settings.saved'))}
        </button>
      </div>
    </div>


    <!-- Navigation -->
    <div class="card">
      <div class="group-title">{$t('settings.navigation.title')}</div>
      <div class="fields">
        <div class="field">
          <div class="field-hint">{$t('settings.navigation.hint')}</div>
          <div class="toggle-grid">
            {#each hideableRoutes as route (route)}
              <label class="toggle">
                <input type="checkbox" bind:checked={routeVisible[route]} />
                {$t(ROUTE_LABEL_KEYS[route] ?? route)}
              </label>
            {/each}
          </div>
        </div>
      </div>
      {#if navError}<p class="section-error">{navError}</p>{/if}
      <div class="section-footer">
        <button class="btn-save" class:saved={navSaved} on:click={saveNavigation} disabled={navSaving}>
          {btnLabel(navSaving, navSaved, $t('settings.save'), $t('settings.saved'))}
        </button>
      </div>
    </div>

    <!-- Web Push -->
    <div class="card">
      <div class="group-title">{$t('settings.push.title')}</div>
      <div class="fields">
        {#if !pushSupported}
          <div class="field">
            <div class="field-hint warn-hint">
              {$t('settings.push.unsupported')}
              {#if !pushStandalone}{' '}{$t('settings.push.unsupportedIos')}{/if}
            </div>
          </div>
        {:else if !push.configured}
          <div class="field">
            <div class="field-hint warn-hint">{$t('settings.push.noKey')}</div>
            <pre class="cli-hint">aiusage generate-vapid-keys</pre>
          </div>
        {:else}
          <div class="field">
            <div class="field-label">{$t('settings.push.thisDevice')}</div>
            <div class="webhook-state">
              {pushSubscribedHere
                ? $t('settings.push.stateSubscribed')
                : pushPermission === 'denied'
                  ? $t('settings.push.stateDenied')
                  : $t('settings.push.stateNotSubscribed')}
            </div>
            {#if !pushSubscribedHere && pushPermission !== 'denied'}
              <input
                type="text"
                bind:value={pushLabel}
                class="field-input"
                placeholder={$t('settings.push.labelPlaceholder')}
                aria-label={$t('settings.push.label')} />
              <div class="field-hint">{$t('settings.push.labelHint')}</div>
              <div class="test-row">
                <!-- The permission prompt is raised here and nowhere else. -->
                <button type="button" class="btn-ghost" on:click={enablePush} disabled={pushBusy}>
                  {pushBusy ? '...' : $t('settings.push.enable')}
                </button>
              </div>
            {:else if pushPermission === 'denied'}
              <div class="field-hint warn-hint">{$t('settings.push.deniedHint')}</div>
            {/if}
          </div>

          <div class="field">
            <div class="field-label">{$t('settings.push.devices')}</div>
            {#if push.subscriptions.length === 0}
              <div class="field-hint">{$t('settings.push.noDevices')}</div>
            {:else}
              <ul class="push-devices">
                {#each push.subscriptions as device (device.id)}
                  <li class="push-device">
                    <div class="push-device-name">
                      {device.label || $t('settings.push.unnamedDevice')}
                      {#if device.id === pushLocalId}<span class="push-here">{$t('settings.push.hereTag')}</span>{/if}
                    </div>
                    <div class="push-device-meta">
                      {#if device.consecutiveFailures > 0}
                        <span class="warn-hint">{$t('settings.push.failing').replace('{count}', String(device.consecutiveFailures))}</span>
                      {/if}
                    </div>
                    <button
                      type="button"
                      class="btn-ghost"
                      on:click={() => removePushDevice(device.id)}
                      disabled={pushBusy}>{$t('settings.push.remove')}</button>
                  </li>
                {/each}
              </ul>
            {/if}
            {#if push.subscriptions.length > 0 && !push.enabled}
              <div class="field-hint warn-hint">{$t('settings.push.channelOff')}</div>
            {/if}
            <div class="test-row">
              <button type="button" class="btn-ghost" on:click={sendPushTestMessage}
                disabled={pushBusy || push.subscriptions.length === 0}>
                {pushBusy ? '...' : $t('settings.push.sendTest')}
              </button>
              {#if pushResult}<span class="test-result">{pushResult}</span>{/if}
            </div>
          </div>

          <div class="field">
            <label class="field-label" for="field-vapid-subject">{$t('settings.push.subject')}</label>
            <input id="field-vapid-subject" type="text" bind:value={vapidSubject} class="field-input" />
            <div class="field-hint">{$t('settings.push.subjectHint')}</div>
            <div class="test-row">
              <button type="button" class="btn-ghost" on:click={saveVapidSubject} disabled={pushBusy}>
                {$t('settings.save')}
              </button>
            </div>
          </div>
        {/if}
        {#if pushError}<div class="field-hint warn-hint">{pushError}</div>{/if}
      </div>
    </div>

    <!-- Notifications -->
    <div class="card">
      <div class="group-title">{$t('settings.notifications.title')}</div>
      <div class="fields">
        <div class="field">
          <label class="toggle">
            <input type="checkbox" bind:checked={notif.enabled} />
            {$t('settings.notifications.enabled')}
          </label>
          <div class="field-hint">{$t('settings.notifications.enabledHint')}</div>
        </div>

        <div class="field">
          <div class="field-label">{$t('settings.notifications.channels')}</div>
          <label class="toggle">
            <input type="checkbox" bind:checked={notif.channelDiscord} />
            {$t('settings.notifications.channelDiscord')}
          </label>
          <label class="toggle">
            <input type="checkbox" bind:checked={notif.channelWebpush} />
            {$t('settings.notifications.channelWebpush')}
          </label>
          <div class="field-hint">{$t('settings.notifications.channelsHint')}</div>
        </div>

        <div class="field">
          <div class="field-label">{$t('settings.notifications.webhook')}</div>
          <div class="webhook-state">
            {webhookConfigured
              ? $t('settings.notifications.webhookSet')
              : $t('settings.notifications.webhookUnset')}
          </div>
          <!-- No input: a secret does not belong on a page that may be served
               over the network, and the CLI reads it from stdin. -->
          <div class="field-hint">{$t('settings.notifications.webhookHint')}</div>
          <div class="test-row">
            <button type="button" class="btn-ghost" on:click={sendTestNotification}
              disabled={testSending || !webhookConfigured}>
              {testSending ? '...' : $t('settings.notifications.sendTest')}
            </button>
            {#if testResult}<span class="test-result">{testResult}</span>{/if}
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="field-notif-prefix">{$t('settings.notifications.prefix')}</label>
          <input id="field-notif-prefix" type="text" bind:value={notif.prefix} class="field-input" placeholder="[aiusage] " />
        </div>

        <div class="field">
          <label class="toggle">
            <input type="checkbox" bind:checked={notif.notifierDevice} />
            {$t('settings.notifications.notifierDevice')}
          </label>
          <div class="field-hint">{$t('settings.notifications.notifierDeviceHint')}</div>
        </div>

        <div class="field">
          <label class="toggle">
            <input type="checkbox" bind:checked={notif.includeAssistantMessage} />
            {$t('settings.notifications.includeAssistant')}
          </label>
          <!-- D10: this sends response text to a third party. The setting is
               off by default and the consequence belongs next to the switch,
               not in a decision record nobody reading this will open. -->
          <div class="field-hint warn-hint">{$t('settings.notifications.includeAssistantHint')}</div>
        </div>

        <div class="field">
          <div class="field-label">{$t('settings.notifications.events')}</div>
          <div class="toggle-grid">
            {#each NOTIFY_EVENTS as key (key)}
              <label class="toggle">
                <input type="checkbox" bind:checked={notif.events[key]} />
                {$t(`agents.status.${key === 'waiting_for_permission' ? 'waitingForPermission' : key === 'waiting_for_user' ? 'waitingForUser' : key}`)}
              </label>
            {/each}
          </div>
          <div class="field-hint">{$t('settings.notifications.eventsHint')}</div>
        </div>

        <div class="field">
          <div class="field-label">{$t('settings.notifications.tools')}</div>
          <div class="toggle-grid">
            {#each Object.keys(notif.tools) as key (key)}
              <label class="toggle">
                <input type="checkbox" bind:checked={notif.tools[key]} />
                {toolLabelFor(key)}
              </label>
            {/each}
          </div>
        </div>

        <div class="field">
          <label class="field-label" for="field-notif-thresholds">{$t('settings.notifications.thresholds')}</label>
          <input id="field-notif-thresholds" type="text" bind:value={notif.thresholds} class="field-input" placeholder="80, 95, 100" />
          <div class="field-hint">{$t('settings.notifications.thresholdsHint')}</div>
        </div>

        <div class="field">
          <div class="field-label">{$t('settings.notifications.quietHours')}</div>
          <div class="rate-row">
            <input type="time" bind:value={notif.quietStart} class="field-input" aria-label={$t('settings.notifications.quietStart')} />
            <input type="time" bind:value={notif.quietEnd} class="field-input" aria-label={$t('settings.notifications.quietEnd')} />
          </div>
          <div class="field-hint">{$t('settings.notifications.quietHoursHint')}</div>
          <div class="toggle-grid">
            {#each NOTIFY_EVENTS as key (key)}
              <label class="toggle">
                <input type="checkbox" bind:checked={notif.quietHoursAllow[key]} />
                {$t(`agents.status.${key === 'waiting_for_permission' ? 'waitingForPermission' : key === 'waiting_for_user' ? 'waitingForUser' : key}`)}
              </label>
            {/each}
          </div>
          <div class="field-hint">{$t('settings.notifications.quietAllowHint')}</div>
        </div>

        <div class="field">
          <label class="field-label" for="field-notif-escalation">{$t('settings.notifications.escalation')}</label>
          <input id="field-notif-escalation" type="text" bind:value={notif.escalation} class="field-input" placeholder="10, 30" />
          <div class="field-hint">{$t('settings.notifications.escalationHint')}</div>
        </div>
      </div>
      {#if notifError}<p class="section-error">{notifError}</p>{/if}
      <div class="section-footer">
        <a class="history-link" href="/notifications">{$t('settings.notifications.openHistory')}</a>
        <button class="btn-save" class:saved={notifSaved} on:click={saveNotifications} disabled={notifSaving}>
          {btnLabel(notifSaving, notifSaved, $t('settings.save'), $t('settings.saved'))}
        </button>
      </div>
    </div>

    <!-- Data Sources -->
    <div class="card">
      <div class="group-title-row">
        <span class="group-title">{$t('settings.dataSources')}</span>
        {#if currentPlatform}
          <span class="platform-badge">{PLATFORM_LABEL[currentPlatform] ?? currentPlatform}</span>
        {/if}
      </div>

      {#if manualImportTools.length}
        <div class="source-group">
          <div class="source-subtitle">{$t('settings.manualImports')}</div>
          <div class="field-hint">{$t('settings.manualImportsHint')}</div>
          <input class="file-input" type="file" accept=".zip,.json,application/zip,application/json" bind:this={kelivoFileInput} on:change={handleKelivoFileChange} />
          <div class="detected-tools-list">
            {#each manualImportTools as tool}
              <div class="detected-tool">
                <div class="detected-tool-header">
                  <span class="status-dot" class:green={tool.status === 'found'} class:gray={tool.status === 'not_found'}></span>
                  <span class="detected-tool-name">{tool.label}</span>
                  <span class="detected-tool-status">
                    {#if tool.sourceKey === 'kelivo'}
                      {kelivoStatus}
                    {:else}
                      {$t('settings.notConfigured')}
                    {/if}
                  </span>
                </div>
                {#if tool.sourceKey === 'kelivo'}
                  <div class="source-actions">
                    <button type="button" class="btn-ghost import-btn" on:click={triggerKelivoImport} disabled={kelivoImporting}>
                      {kelivoImporting ? '...' : $t('settings.importBackup')}
                    </button>
                    {#if kelivoImportedCount !== null}
                      <span class="source-result">
                        {$t('settings.imported')} {kelivoImportedCount} {$t('settings.records')}
                        {#if kelivoAddedCount !== null}
                          · {$t('settings.added')} {kelivoAddedCount} {$t('settings.records')}
                        {/if}
                      </span>
                    {/if}
                  </div>
                  {#if kelivoImportError}<p class="section-error compact">{kelivoImportError}</p>{/if}
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="source-group">
        <div class="source-subtitle">{$t('settings.detectedTools')}</div>
        <div class="field-hint">{$t('settings.detectedToolsHint')}</div>
        <div class="detected-tools-list">
          {#each activeTools as tool}
            <div class="detected-tool">
              <div class="detected-tool-header">
                <span class="status-dot" class:green={tool.status === 'found'} class:yellow={tool.status === 'empty'}></span>
                <span class="detected-tool-name">{tool.label}</span>
                <span class="detected-tool-status">
                  {#if tool.status === 'found'}
                    {$t('settings.toolFound')} · {tool.fileCount} {$t('settings.toolFiles')}
                  {:else}
                    {$t('settings.toolEmpty')}
                  {/if}
                </span>
              </div>
              {#if tool.paths?.length}
                {#each tool.paths as path}
                  <div class="detected-tool-path">{path}</div>
                {/each}
              {:else if tool.path}
                <div class="detected-tool-path">{tool.path}</div>
              {/if}
            </div>
          {/each}
          {#if notFoundTools.length}
            <button class="not-found-toggle" on:click={() => showNotFound = !showNotFound}>
              <span class="not-found-chevron" class:open={showNotFound}>&#9654;</span>
              {$t('settings.toolNotFound')} ({notFoundTools.length})
            </button>
            {#if showNotFound}
              {#each notFoundTools as tool}
                <div class="detected-tool not-found">
                  <div class="detected-tool-header">
                    <span class="status-dot gray"></span>
                    <span class="detected-tool-name">{tool.label}</span>
                  </div>
                  {#if tool.path}
                    <div class="detected-tool-path">{tool.path}</div>
                  {/if}
                </div>
              {/each}
            {/if}
          {/if}
        </div>
      </div>
    </div>

    <!-- Sync -->
    <div class="card sync-card">
      <div class="group-title">{$t('settings.sync')}</div>
      <div class="fields">
        <div class="field full">
          <label class="field-label" for="field-sync-backend">{$t('settings.syncBackend')}</label>
          <select id="field-sync-backend" bind:value={syncData.backend} class="field-input" on:change={onBackendChange}>
            <option value="">{$t('settings.syncBackendNone')}</option>
            {#if cloudSyncAvailable}
              <option value="cloud">AIUsage Cloud</option>
            {/if}
            <option value="github">GitHub</option>
            <option value="s3">S3 / Compatible</option>
          </select>
          <div class="field-hint">
            {#if syncData.backend === 'cloud'}
              {$t('settings.syncBackendCloudDesc')}
            {:else if syncData.backend === 'github'}
              {$t('settings.syncBackendGithubDesc')}
            {:else if syncData.backend === 's3'}
              {$t('settings.syncBackendS3Desc')}
            {:else}
              {$t('settings.syncBackendNoneDesc')}
            {/if}
          </div>
        </div>

        {#if syncData.backend === 'cloud'}
          {#if !cloudSyncAvailable}
            <div class="field full">
              <div class="cloud-status">
                <span class="status-dot err"></span>
                <span>{$t('settings.cloudUnavailable')}</span>
              </div>
            </div>
          {:else}
          <div class="field full">
            <div class="cloud-setup">
              <div class="cloud-setup-title">{$t('settings.syncCloudSetup')}</div>
              <div class="cloud-steps">
                <div class="cloud-step">
                  <span class="cloud-step-num">1</span>
                  <div class="cloud-step-body">
                    <span class="cloud-step-label">
                      <a href="https://aiusage.jtanx.com/settings#accounts" target="_blank" rel="noopener noreferrer" class="cloud-step-link">{$t('settings.syncCloudStep1')}</a>
                    </span>
                  </div>
                </div>
                <div class="cloud-step">
                  <span class="cloud-step-num">2</span>
                  <div class="cloud-step-body">
                    <span class="cloud-step-label">
                      <a href="https://github.com/juliantanx/aiusage" target="_blank" rel="noopener noreferrer" class="cloud-step-link">{$t('settings.syncCloudStep2')}</a>
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div class="cloud-status" class:logged-in={cloudLoggedIn}>
              {#if cloudLoggedIn}
                <span class="status-dot ok"></span>
                <span>{$t('settings.cloudLoggedIn')}</span>
              {:else}
                <span class="status-dot"></span>
                <span>{$t('settings.cloudNotLoggedIn')}</span>
              {/if}
            </div>
          </div>
          {/if}
        {/if}

        {#if syncData.backend === 'github'}
          <div class="field">
            <label class="field-label" for="field-sync-repo">{$t('settings.syncRepo')}</label>
            <input id="field-sync-repo" type="text" bind:value={syncData.repo} class="field-input mono"
              placeholder="owner/repo" on:input={onRepoChange} />
          </div>
          <div class="field full">
            <label class="field-label" for="field-gh-token">GitHub Token</label>
            <div class="field-hint">
              {$t('settings.credentialStoredAs')}
              <code class="key-hint">{syncData.repo ? ghKey(syncData.repo) : 'github/owner/repo/token'}</code>
            </div>
            <div class="credential-row">
              <input id="field-gh-token" type={ghTokenVisible ? 'text' : 'password'}
                value={ghToken} on:input={e => ghToken = e.target.value}
                class="field-input mono" autocomplete="new-password"
                placeholder={ghTokenIsSet ? $t('settings.credentialSet') : $t('settings.credentialNotSet')} />
              <button type="button" class="btn-ghost" on:click={toggleGhToken}
                disabled={ghTokenLoading || !syncData.repo}>
                {#if ghTokenLoading}...{:else if ghTokenVisible}{$t('settings.hideCredential')}{:else}{$t('settings.showCredential')}{/if}
              </button>
            </div>
          </div>
        {/if}

        {#if syncData.backend === 's3'}
          <div class="field">
            <label class="field-label" for="field-sync-bucket">{$t('settings.syncBucket')}</label>
            <input id="field-sync-bucket" type="text" bind:value={syncData.bucket} class="field-input mono"
              placeholder="my-bucket" on:input={onBucketChange} />
          </div>
          <div class="field">
            <label class="field-label" for="field-sync-prefix">{$t('settings.syncPrefix')}</label>
            <input id="field-sync-prefix" type="text" bind:value={syncData.prefix} class="field-input mono" placeholder="aiusage/" />
          </div>
          <div class="field">
            <label class="field-label" for="field-sync-endpoint">{$t('settings.syncEndpoint')}</label>
            <input id="field-sync-endpoint" type="text" bind:value={syncData.endpoint} class="field-input mono" placeholder="https://s3.amazonaws.com" />
          </div>
          <div class="field">
            <label class="field-label" for="field-sync-region">{$t('settings.syncRegion')}</label>
            <input id="field-sync-region" type="text" bind:value={syncData.region} class="field-input mono" placeholder="auto" />
          </div>
          <div class="field full">
            <label class="field-label" for="field-s3-akid">Access Key ID</label>
            <div class="field-hint">
              {$t('settings.credentialStoredAs')}
              <code class="key-hint">{syncData.bucket ? s3AkidKey(syncData.bucket) : 's3/my-bucket/accessKeyId'}</code>
            </div>
            <div class="credential-row">
              <input id="field-s3-akid" type={s3AkidVisible ? 'text' : 'password'}
                value={s3AkidValue} on:input={e => s3AkidValue = e.target.value}
                class="field-input mono" autocomplete="new-password"
                placeholder={s3AkidIsSet ? $t('settings.credentialSet') : $t('settings.credentialNotSet')} />
              <button type="button" class="btn-ghost" on:click={toggleS3Akid}
                disabled={s3AkidLoading || !syncData.bucket}>
                {#if s3AkidLoading}...{:else if s3AkidVisible}{$t('settings.hideCredential')}{:else}{$t('settings.showCredential')}{/if}
              </button>
            </div>
          </div>
          <div class="field full">
            <label class="field-label" for="field-s3-sak">Secret Access Key</label>
            <div class="field-hint">
              {$t('settings.credentialStoredAs')}
              <code class="key-hint">{syncData.bucket ? s3SakKey(syncData.bucket) : 's3/my-bucket/secretAccessKey'}</code>
            </div>
            <div class="credential-row">
              <input id="field-s3-sak" type={s3SakVisible ? 'text' : 'password'}
                value={s3SakValue} on:input={e => s3SakValue = e.target.value}
                class="field-input mono" autocomplete="new-password"
                placeholder={s3SakIsSet ? $t('settings.credentialSet') : $t('settings.credentialNotSet')} />
              <button type="button" class="btn-ghost" on:click={toggleS3Sak}
                disabled={s3SakLoading || !syncData.bucket}>
                {#if s3SakLoading}...{:else if s3SakVisible}{$t('settings.hideCredential')}{:else}{$t('settings.showCredential')}{/if}
              </button>
            </div>
          </div>
        {/if}
        {#if syncData.backend}
          <div class="field full">
            <div class="auto-sync-toggle-row">
              <label class="toggle-row">
                <input type="checkbox" bind:checked={autoSyncEnabled} />
                <span class="switch" aria-hidden="true"></span>
                <span>
                  <strong>{$t('settings.autoSync')}</strong>
                </span>
              </label>
              {#if autoSyncEnabled}
                <label class="interval-control">
                  <span>{$t('settings.syncFrequency')}</span>
                  <select bind:value={syncIntervalMinutes}>
                    <option value="5">5 {$t('settings.syncMinutes')}</option>
                    <option value="15">15 {$t('settings.syncMinutes')}</option>
                    <option value="30">30 {$t('settings.syncMinutes')}</option>
                    <option value="60">1 {$t('settings.syncHour')}</option>
                    <option value="120">2 {$t('settings.syncHours')}</option>
                    <option value="360">6 {$t('settings.syncHours')}</option>
                    <option value="720">12 {$t('settings.syncHours')}</option>
                    <option value="1440">24 {$t('settings.syncHours')}</option>
                  </select>
                </label>
              {/if}
            </div>
          </div>
        {/if}
      </div>
      {#if syncError}<p class="section-error">{syncError}</p>{/if}
      <div class="section-footer">
        <button class="btn-save" class:saved={syncSaved} on:click={saveSync} disabled={syncSaving}>
          {btnLabel(syncSaving, syncSaved, $t('settings.save'), $t('settings.saved'))}
        </button>
      </div>

      {#if syncData.backend}
        <div class="sync-status-section">
          <div class="group-title">{$t('settings.syncStatus')}</div>
          <div class="sync-status-grid">
            <div class="sync-status-item">
              <span class="sync-status-label">{$t('settings.syncLastSync')}</span>
              <span class="sync-status-value mono">{formatSyncTime(displayedSyncStatus?.lastSyncAt)}</span>
            </div>
            {#if syncStatusData?.nextSyncAt}
              <div class="sync-status-item">
                <span class="sync-status-label">{$t('settings.syncNextSync')}</span>
                <span class="sync-status-value mono">{formatSyncTime(syncStatusData.nextSyncAt)}</span>
              </div>
            {/if}
            <div class="sync-status-item">
              <span class="sync-status-label">{$t('settings.syncStatusLabel')}</span>
              <span class="sync-status-value" class:ok={displayedSyncStatus?.lastSyncStatus === 'ok'} class:err={displayedSyncStatus?.lastSyncStatus === 'failed'}>
                {#if syncRunning}
                  {syncStatusData?.phase ? $t(`sync.phase.${syncStatusData.phase}`) : $t('sync.syncing')}
                {:else if displayedSyncStatus?.lastSyncStatus === 'ok'}
                  {$t('sync.complete')}
                {:else if displayedSyncStatus?.lastSyncStatus}
                  {$t('sync.failed')}
                {:else}
                  —
                {/if}
              </span>
            </div>
            {#if displayedSyncStatus?.lastSyncPulled != null && displayedSyncStatus?.lastSyncStatus === 'ok'}
              <div class="sync-status-item">
                <span class="sync-status-label">{$t('settings.syncPulled')}</span>
                <span class="sync-status-value mono">{displayedSyncStatus.lastSyncPulled}</span>
              </div>
              <div class="sync-status-item">
                <span class="sync-status-label">{$t('settings.syncUploaded')}</span>
                <span class="sync-status-value mono">{displayedSyncStatus.lastSyncUploaded ?? 0}</span>
              </div>
            {/if}
            {#if displayedSyncStatus?.lastSyncError && displayedSyncStatus?.lastSyncStatus !== 'ok'}
              <div class="sync-status-item full">
                <span class="sync-status-label">{$t('settings.syncError')}</span>
                <span class="sync-status-value err">
                  {#if displayedSyncStatus.lastSyncError.includes('CLOUD_SYNC_DISABLED') || displayedSyncStatus.lastSyncError.includes('currently unavailable')}
                    {$t('settings.cloudUnavailable')}
                  {:else if displayedSyncStatus.lastSyncError.includes('USER_CLOUD_BANNED') || displayedSyncStatus.lastSyncError.includes('disabled by an administrator')}
                    {$t('settings.cloudBanned')}
                  {:else if displayedSyncStatus.lastSyncError.includes('star') || displayedSyncStatus.lastSyncError.includes('Star') || displayedSyncStatus.lastSyncError.includes('STAR_REQUIRED')}
                    {$t('settings.syncStarRequired')}
                    <a href="https://github.com/juliantanx/aiusage" target="_blank" rel="noopener noreferrer" class="cloud-step-link">{$t('settings.syncCloudStep2')}</a>
                  {:else if displayedSyncStatus.lastSyncError.includes('bind') || displayedSyncStatus.lastSyncError.includes('GitHub') || displayedSyncStatus.lastSyncError.includes('GITHUB_BINDING')}
                    {$t('settings.syncGithubBindingRequired')}
                    <a href="https://aiusage.jtanx.com/settings#accounts" target="_blank" rel="noopener noreferrer" class="cloud-step-link">{$t('settings.syncCloudStep1')}</a>
                  {:else}
                    {displayedSyncStatus.lastSyncError}
                  {/if}
                </span>
              </div>
            {/if}
            {#if displayedSyncStatus?.lastSyncDurationMs != null && displayedSyncStatus?.lastSyncStatus === 'ok'}
              <div class="sync-status-item">
                <span class="sync-status-label">{$t('settings.syncDuration')}</span>
                <span class="sync-status-value mono">{(displayedSyncStatus.lastSyncDurationMs / 1000).toFixed(1)}s</span>
              </div>
            {/if}
            {#if displayedSyncStatus?.lastSyncPulled != null && displayedSyncStatus?.lastSyncStatus === 'ok'}
              <div class="sync-status-hint">{$t('settings.syncCountHint')}</div>
            {/if}
          </div>
          <div class="sync-action">
            {#if syncDirty && !syncRunning}
              <div class="sync-unsaved-warn">{$t('settings.syncUnsavedHint')}</div>
            {/if}
            <button class="btn-sync" on:click={handleSyncFromSettings} disabled={syncRunning || syncSaving || syncDirty}>
              {#if syncRunning}
                {syncStatusData?.phase ? $t(`sync.phase.${syncStatusData.phase}`) : $t('sync.syncing')}
                {#if syncStatusData?.pulledCount || syncStatusData?.uploadedCount}
                  <span class="sync-progress-counts">
                    {#if syncStatusData.pulledCount}↓{syncStatusData.pulledCount}{/if}
                    {#if syncStatusData.uploadedCount}↑{syncStatusData.uploadedCount}{/if}
                  </span>
                {/if}
              {:else}
                {syncSaving ? '...' : $t('settings.syncNow')}
              {/if}
            </button>
          </div>
        </div>
      {/if}
    </div>

  </div>
{/if}

<style>
  .sections {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: none;
  }

  .card {
    background: var(--surface);
    border-radius: var(--radius-card);
    padding: 1.25rem;
  }
  .sync-card { order: -1; }

  .group-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .group-title {
    font-size: 0.75rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .group-title-row .group-title {
    margin-bottom: 0;
  }

  .platform-badge {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: var(--radius-badge);
    background: var(--accent-dim);
    color: var(--accent);
    letter-spacing: 0.04em;
  }

  .source-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .source-group + .source-group {
    margin-top: 1rem;
    padding-top: 0.875rem;
    border-top: var(--border-width) solid var(--border-subtle);
  }

  .source-subtitle {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .field { display: flex; flex-direction: column; gap: 0.2rem; }
  .field.full { grid-column: 1 / -1; }

  .field-label {
    font-size: 0.75rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
  }
  .field-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .key-hint {
    font-family: var(--mono);
    font-size: 0.75rem;
    background: var(--raised);
    padding: 0.05rem 0.3rem;
    border-radius: var(--radius-xs);
    border: var(--border-width) solid var(--border-subtle);
    color: var(--text-secondary);
  }

  .field-input {
    font-family: var(--font-sans);
    font-size: 0.85rem;
    padding: 0 0.65rem;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-input);
    background: var(--raised);
    color: var(--text);
    transition: border-color 0.15s;
    width: 100%;
    height: 32px;
  }
  .field-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .field-input.mono { font-family: var(--mono); font-size: 0.8rem; }

  select.field-input { cursor: pointer; appearance: auto; }

  .section-error {
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: var(--rose);
  }
  .section-error.compact { margin: 0.5rem 0 0 1.25rem; }

  .section-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.75rem;
    padding-top: 0.625rem;
    border-top: var(--border-width) solid var(--border-subtle);
  }

  .btn-save {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.375rem 1rem;
    border: var(--border-width) solid var(--accent);
    border-radius: var(--radius-input);
    background: var(--accent);
    color: var(--surface);
    cursor: pointer;
    transition: background 0.15s;
    min-width: 64px;
  }
  .btn-save:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .btn-save:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn-save.saved {
    border-color: var(--green);
    background: transparent;
    color: var(--green);
  }

  .sync-status-section {
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: var(--border-width) solid var(--border-subtle);
  }
  .sync-status-section .group-title {
    margin-bottom: 0.5rem;
  }
  .sync-status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.375rem 1.5rem;
  }
  .sync-status-item {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.25rem 0;
  }
  .sync-status-item.full {
    grid-column: 1 / -1;
  }
  .sync-status-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
  }
  .sync-status-hint {
    grid-column: 1 / -1;
    font-size: 0.75rem;
    color: var(--text-muted);
    padding-top: 0.125rem;
  }
  .sync-status-value {
    font-size: 0.8125rem;
    color: var(--text);
    text-align: right;
  }
  .sync-status-value.ok { color: var(--green); }
  .sync-status-value.err { color: var(--rose); }
  .sync-action {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
  }
  .sync-unsaved-warn {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--amber);
    background: color-mix(in oklab, var(--amber) 10%, transparent);
    border: var(--border-width) solid color-mix(in oklab, var(--amber) 25%, transparent);
    border-radius: var(--radius-input);
    padding: 0.375rem 0.625rem;
  }
  .btn-sync {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.375rem 1rem;
    border: var(--border-width) solid var(--border-medium);
    border-radius: var(--radius-input);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-sync:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .btn-sync:disabled { opacity: 0.55; cursor: not-allowed; }

  .sync-progress-counts {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
    margin-left: 0.25rem;
  }

  .auto-sync-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .toggle-row {
    display: flex;
    gap: 0.625rem;
    align-items: center;
    min-width: 0;
    cursor: pointer;
  }

  .toggle-row input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .switch {
    position: relative;
    width: 34px;
    height: 20px;
    border: var(--border-width) solid var(--border-medium);
    border-radius: var(--radius-pill);
    background: var(--raised);
    transition: background 160ms ease, border-color 160ms ease;
    flex-shrink: 0;
  }

  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-secondary);
    transition: transform 160ms ease, background 160ms ease;
  }

  .toggle-row input:checked + .switch {
    border-color: var(--accent);
    background: var(--accent);
  }

  .toggle-row input:checked + .switch::after {
    background: var(--on-accent);
    transform: translateX(14px);
  }

  .toggle-row input:focus-visible + .switch {
    outline: 2px solid color-mix(in oklab, var(--accent) 40%, transparent);
    outline-offset: 2px;
  }

  .toggle-row strong {
    display: block;
    color: var(--text);
    font-size: 0.8125rem;
  }

  .interval-control {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 650;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .interval-control select {
    min-height: 32px;
    padding: 0 1.875rem 0 0.625rem;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-input);
    background: var(--surface);
    color: var(--text-secondary);
    font: inherit;
    cursor: pointer;
  }

  .state-msg { color: var(--text-muted); padding: 2rem; text-align: center; }
  .state-msg.error { color: var(--rose); }

  .cloud-setup {
    background: var(--raised);
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-card);
    padding: 0.875rem 1rem;
    margin-bottom: 0.75rem;
  }
  .cloud-setup-title {
    font-size: 0.6875rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 0.625rem;
  }
  .cloud-steps {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .cloud-step {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
  }
  .cloud-step-num {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1.5px solid var(--border-medium);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--mono);
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
    margin-top: 0.0625rem;
  }
  .cloud-step-body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .cloud-step-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }
  .cloud-step-link {
    font-size: 0.75rem;
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
  }
  .cloud-step-link:hover {
    text-decoration: underline;
  }
  .cloud-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    padding: 0.5rem 0;
  }
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .status-dot.ok {
    background: var(--green);
  }

  .credential-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .credential-row .field-input {
    flex: 1;
  }

  .btn-ghost {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: var(--radius-input);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
    transition: color 0.15s;
  }

  .btn-ghost:hover {
    color: var(--accent);
  }

  .btn-ghost:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .rate-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .rate-row .field-input { flex: 1; }

  .rate-time {
    color: var(--text-muted);
    font-size: 0.75rem;
    margin-left: 0.25rem;
  }

  .detected-tools-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .detected-tool {
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-input);
    background: var(--raised);
    border: var(--border-width) solid var(--border-subtle);
  }

  .detected-tool-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.green { background: var(--green); }
  .status-dot.yellow { background: var(--amber); }
  .status-dot.gray { background: var(--text-muted); opacity: 0.4; }

  .detected-tool-name {
    font-family: var(--mono);
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
  }

  .detected-tool-status {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-left: auto;
  }

  .not-found-toggle {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-weight: 550;
    color: var(--text-muted);
    background: none;
    border: none;
    padding: 0.375rem 0.25rem;
    cursor: pointer;
    transition: color 0.12s;
  }
  .not-found-toggle:hover {
    color: var(--text-secondary);
  }

  .not-found-chevron {
    font-size: 0.5rem;
    transition: transform 0.15s;
    display: inline-block;
  }
  .not-found-chevron.open {
    transform: rotate(90deg);
  }

  .detected-tool.not-found {
    opacity: 0.6;
  }

  .detected-tool-path {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin-top: 0.2rem;
    margin-left: 1.25rem;
    word-break: break-all;
  }

  .file-input { display: none; }

  .source-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
    margin-left: 1.25rem;
  }

  .import-btn {
    padding-left: 0;
  }

  .source-result {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--green);
  }

  @media (max-width: 640px) {
    .fields {
      grid-template-columns: 1fr;
    }
    .detected-tool-header,
    .source-actions {
      align-items: flex-start;
    }
    .detected-tool-status {
      margin-left: 0;
    }
    .detected-tool-header {
      flex-wrap: wrap;
    }
    .source-actions {
      flex-direction: column;
      gap: 0.25rem;
    }
  }

  /* ── Notifications section ─────────────────────────────────────────── */

  .toggle {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8125rem;
    cursor: pointer;
  }

  .toggle-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.25rem;
    margin-top: 0.35rem;
  }

  .webhook-state {
    font-size: 0.8125rem;
    margin-bottom: 0.15rem;
  }

  .test-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.5rem;
  }

  .test-result {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  /* A command to run in a terminal, shown as one. */
  .cli-hint {
    font-family: var(--mono);
    font-size: 0.75rem;
    background: var(--surface);
    border: var(--border-width) solid var(--border-subtle);
    padding: 0.4rem 0.6rem;
    margin: 0.4rem 0 0;
    overflow-x: auto;
  }

  .push-devices {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .push-device {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.8125rem;
  }

  .push-device-name {
    /* Takes the slack so the remove button stays at the right edge. */
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .push-device-meta {
    font-size: 0.75rem;
  }

  .push-here {
    font-size: 0.6875rem;
    color: var(--text-secondary);
    margin-left: 0.4rem;
  }

  /* Sending response text off the machine deserves more than the usual grey. */
  .warn-hint {
    color: var(--danger-fg);
  }

  .history-link {
    font-size: 0.8125rem;
    color: var(--accent);
    text-decoration: none;
    margin-right: auto;
  }

  .history-link:hover {
    text-decoration: underline;
  }
</style>
