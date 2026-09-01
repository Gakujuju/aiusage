<script>
  import { page } from '$app/stores'
  import { onDestroy, onMount } from 'svelte'
  import { lang, toggleLang, t } from '$lib/i18n.js'

  const LANG_SHORT = { en: 'EN', zh: '中', ja: '日' }
  const LANG_NAME = { en: 'English', zh: '中文', ja: '日本語' }
  import { userPref, cycleTheme, initTheme } from '$lib/theme.js'
  import { fetchConfig, fetchAuthStatus, login, setUnauthorizedHandler } from '$lib/api.js'
  import { displayCurrency, exchangeRate } from '$lib/stores.js'
  import { getAuthShellState } from '$lib/auth-shell.js'
  import ParseStallBanner from '$lib/components/ParseStallBanner.svelte'
  import { initServiceWorkerUpdates, updateReady, applyUpdate } from '$lib/sw-update.js'
  import {
    House, LayoutDashboard, Coins, DollarSign, Box,
    MessageSquare, FolderKanban, Wrench, Activity, Bell,
    Gauge, Tag, Trophy, Settings, HelpCircle,
    Sun, Moon, MonitorCog,
    Languages, PanelLeftClose, PanelLeftOpen, ExternalLink, SquareTerminal
  } from 'lucide-svelte'

  const NAV_GROUPS = [
    {
      key: 'nav.group.overview',
      items: [
        { path: '/',           key: 'nav.home',      icon: House },
        { path: '/overview',   key: 'nav.overview',  icon: LayoutDashboard },
      ]
    },
    {
      key: 'nav.group.analytics',
      items: [
        { path: '/tokens',     key: 'nav.tokens',    icon: Coins },
        { path: '/cost',       key: 'nav.cost',      icon: DollarSign },
        { path: '/models',     key: 'nav.models',    icon: Box },
      ]
    },
    {
      key: 'nav.group.activity',
      items: [
        { path: '/agents',     key: 'nav.agents',    icon: Activity },
        { path: '/sessions',   key: 'nav.sessions',  icon: MessageSquare },
        { path: '/projects',   key: 'nav.projects',  icon: FolderKanban },
        { path: '/tool-calls', key: 'nav.toolCalls', icon: Wrench },
      ]
    },
    {
      key: 'nav.group.system',
      items: [
        { path: '/quotas',     key: 'nav.quotas',    icon: Gauge },
        { path: '/notifications', key: 'nav.notifications', icon: Bell },
        { path: '/pricing',    key: 'nav.pricing',   icon: Tag },
        { path: '/leaderboard', key: 'nav.leaderboard', icon: Trophy },
        { path: '/settings',   key: 'nav.settings',  icon: Settings },
        { path: '/support',    key: 'nav.support',   icon: HelpCircle },
      ]
    }
  ]

  const SIDEBAR_KEY = 'aiusage-sidebar-collapsed'

  /**
   * Screens the user has switched off, from config.
   *
   * Hidden means "not in the navigation", not "gone": a bookmark to one still
   * resolves, and lands on a note saying it was turned off rather than a 404.
   * Claiming a working feature does not exist would send someone hunting for
   * a bug that is not there.
   */
  /** @type {string[]} */
  let hiddenRoutes = []
  $: hiddenSet = new Set(hiddenRoutes)
  // A group whose every item is hidden leaves its heading behind otherwise.
  $: visibleNavGroups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !hiddenSet.has(item.path)) }))
    .filter((group) => group.items.length > 0)
  $: routeHidden = hiddenSet.has($page.url.pathname)

  let collapsed = false
  let mobileOpen = false

  const themeIcons = { system: MonitorCog, dark: Moon, light: Sun, terminal: SquareTerminal }

  let authLoading = true
  let authEnabled = false
  let authenticated = false
  /**
   * Whether the home page shows anything without a login. Only the server
   * knows — it depends on what it bound to. Defaults to the old behaviour so
   * an older serve, which does not send the field, keeps working.
   */
  let publicHome = true
  let password = ''
  let authError = ''
  let authSubmitting = false
  let unlockOpen = false

  $: isHomeRoute = $page.url.pathname === '/'
  $: shellState = getAuthShellState({
    pathname: $page.url.pathname,
    authEnabled,
    authenticated,
    authLoading,
    publicHome,
  })
  $: shouldShowLogin = shellState === 'login-page'
  $: shouldShowPublicHome = shellState === 'public-home'

  async function loadAuthStatus() {
    try {
      const status = await fetchAuthStatus()
      authEnabled = Boolean(status.enabled)
      authenticated = Boolean(status.authenticated)
      // Absent on an older serve, and absent must mean "public" — reading it
      // as locked would put a login page in front of a home page that works.
      publicHome = status.publicHome !== false
    } catch {
      authEnabled = false
      authenticated = false
      publicHome = true
    } finally {
      authLoading = false
    }
  }

  async function handleLogin() {
    authError = ''
    authSubmitting = true
    try {
      await login(password)
      authenticated = true
      password = ''
      unlockOpen = false
      fetchConfig().then(applyConfig).catch(() => {})
    } catch (err) {
      authError = err instanceof Error ? err.message : $t('auth.loginFailed')
    } finally {
      authSubmitting = false
    }
  }

  function toggleSidebar() {
    collapsed = !collapsed
    if (typeof window !== 'undefined') {
      localStorage.setItem(SIDEBAR_KEY, String(collapsed))
    }
  }

  function toggleMobile() {
    mobileOpen = !mobileOpen
  }

  function openUnlock() {
    if (authLoading) return
    unlockOpen = true
    authError = ''
  }

  function closeUnlock() {
    unlockOpen = false
    authError = ''
    password = ''
  }

  /**
   * What the status line shows. Both are real values, not decoration: the
   * interval the pages actually poll at, and the clock.
   */
  let refreshMs = 30000
  let statusClock = ''
  /** @type {any} */
  let statusClockTimer = null

  function applyConfig(cfg) {
    if (cfg.refreshInterval) refreshMs = cfg.refreshInterval
    if (cfg.displayCurrency) displayCurrency.set(cfg.displayCurrency)
    if (cfg.exchangeRateCache?.CNY_USD) exchangeRate.set(cfg.exchangeRateCache.CNY_USD)
    if (cfg.exchangeRate) exchangeRate.set(cfg.exchangeRate)
    hiddenRoutes = Array.isArray(cfg.ui?.hiddenRoutes) ? cfg.ui.hiddenRoutes : []
  }

  /**
   * A 401 from anywhere means the session this shell was drawn for is gone.
   * Asking the server settles it, and if we really are logged out the shell
   * becomes the login page — instead of a navigation full of pages that all
   * say "Authentication required" and offer a refresh button.
   *
   * Re-entrancy guard: a page in flight can fire several 401s at once, and
   * each would otherwise start its own status request.
   */
  let recheckingAuth = false
  function onUnauthorized() {
    if (recheckingAuth || !authEnabled || authLoading) return
    recheckingAuth = true
    loadAuthStatus().finally(() => { recheckingAuth = false })
  }

  /** @type {(() => void) | null} */
  let stopUpdates = null

  onMount(() => {
    initTheme()
    // Notices a new build while the app is open, and applies it on the way
    // back in. Without this the screen was always one launch behind.
    //
    // Torn down from the onDestroy below rather than by calling onDestroy
    // here: a lifecycle function inside a callback throws, which took the
    // rest of this handler with it and left the app on "checking access".
    stopUpdates = initServiceWorkerUpdates()
    loadAuthStatus()
    setUnauthorizedHandler(onUnauthorized)
    const tick = () => {
      statusClock = new Date().toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    }
    tick()
    statusClockTimer = setInterval(tick, 1000)
    // Initialize currency stores from config
    fetchConfig().then(applyConfig).catch(() => {})
    if (typeof window !== 'undefined') {
      collapsed = localStorage.getItem(SIDEBAR_KEY) === 'true'
    }
  })

  onDestroy(() => {
    stopUpdates?.()
    setUnauthorizedHandler(null)
    if (statusClockTimer != null) clearInterval(statusClockTimer)
  })

  $: $page, mobileOpen = false
</script>

{#if mobileOpen && shellState === 'shell'}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="mobile-backdrop" on:click={toggleMobile}></div>
{/if}

{#if shouldShowLogin}
  <main class="auth-page">
    <section class="auth-card">
      <a href="/" class="brand auth-brand">
        <svg class="brand-logo" width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="currentColor"/>
          <rect x="10" y="38" width="12" height="16" rx="3" fill="white"/>
          <rect x="26" y="26" width="12" height="28" rx="3" fill="white"/>
          <rect x="42" y="14" width="12" height="40" rx="3" fill="white"/>
        </svg>
        <span class="brand-name">AIUsage</span>
      </a>
      <h1>{$t('auth.locked')}</h1>
      <p>{$t('auth.lockedHint')}</p>
      <form on:submit|preventDefault={handleLogin}>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          type="password"
          bind:value={password}
          placeholder={$t('auth.password')}
          autocomplete="current-password"
          autofocus
        />
        <button type="submit" disabled={authSubmitting || !password}>
          {authSubmitting ? $t('auth.unlocking') : $t('auth.unlock')}
        </button>
      </form>
      {#if authError}
        <div class="auth-error">{authError}</div>
      {/if}
      <!-- Only when there is a public home to go back to. Otherwise this link
           returns to this same page, which is the dead end in miniature. -->
      {#if publicHome}
        <a class="auth-home" href="/">{$t('auth.backHome')}</a>
      {/if}
    </section>
  </main>
{:else if shellState === 'loading'}
  <main class="auth-page">
    <section class="auth-card">
      <div class="auth-loading">{$t('auth.checking')}</div>
    </section>
  </main>
{:else if shouldShowPublicHome}
  <div class="public-shell">
    <header class="public-header">
      <button class="public-unlock" type="button" on:click={openUnlock} aria-label={$t('auth.unlockDashboard')}>
        <svg class="brand-logo" width="20" height="20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="currentColor"/>
          <rect x="10" y="38" width="12" height="16" rx="3" fill="white"/>
          <rect x="26" y="26" width="12" height="28" rx="3" fill="white"/>
          <rect x="42" y="14" width="12" height="40" rx="3" fill="white"/>
        </svg>
        <span>AIUsage</span>
      </button>
      <div class="public-actions">
        <!-- The brand above opens the same dialog, but a logo does not read as
             a way in. Someone looking at a page of 401s needs a button that
             says what it does. -->
        <button class="public-signin" type="button" on:click={openUnlock}>
          {$t('auth.signIn')}
        </button>
        <button class="public-lang" type="button" on:click={toggleLang} title={LANG_NAME[$lang]}>
          {LANG_SHORT[$lang]}
        </button>
      </div>
    </header>

    <main class="public-page-content">
      <div class="public-page-inner">
        <slot />
      </div>
    </main>
  </div>

  {#if unlockOpen}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="auth-modal-backdrop" on:click={closeUnlock}></div>
    <section class="auth-card auth-modal" role="dialog" aria-modal="true" aria-labelledby="unlock-title">
      <button class="auth-close" type="button" on:click={closeUnlock} aria-label="Close">×</button>
      <div class="brand auth-brand">
        <svg class="brand-logo" width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="currentColor"/>
          <rect x="10" y="38" width="12" height="16" rx="3" fill="white"/>
          <rect x="26" y="26" width="12" height="28" rx="3" fill="white"/>
          <rect x="42" y="14" width="12" height="40" rx="3" fill="white"/>
        </svg>
        <span class="brand-name">AIUsage</span>
      </div>
      <h1 id="unlock-title">{$t('auth.unlockDashboard')}</h1>
      <p>{$t('auth.unlockHint')}</p>
      <form on:submit|preventDefault={handleLogin}>
        <!-- svelte-ignore a11y-autofocus -->
        <input
          type="password"
          bind:value={password}
          placeholder={$t('auth.password')}
          autocomplete="current-password"
          autofocus
        />
        <button type="submit" disabled={authSubmitting || !password}>
          {authSubmitting ? $t('auth.unlocking') : $t('auth.unlock')}
        </button>
      </form>
      {#if authError}
        <div class="auth-error">{authError}</div>
      {/if}
    </section>
  {/if}
{:else}
<div class="app" class:collapsed>

  <aside class="sidebar" class:open={mobileOpen}>
    <div class="sidebar-inner">

      <a href="/" class="brand">
        <svg class="brand-logo" width="20" height="20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="currentColor"/>
          <rect x="10" y="38" width="12" height="16" rx="3" fill="white"/>
          <rect x="26" y="26" width="12" height="28" rx="3" fill="white"/>
          <rect x="42" y="14" width="12" height="40" rx="3" fill="white"/>
        </svg>
        {#if !collapsed}
          <span class="brand-name">AIUsage</span>
        {/if}
      </a>

      <nav class="sidebar-nav">
        {#each visibleNavGroups as group}
          <div class="nav-group">
            {#if !collapsed}
              <div class="group-label">{$t(group.key)}</div>
            {/if}
            {#each group.items as item}
              <a
                href={item.path}
                class="nav-item"
                class:active={$page.url.pathname === item.path}
                title={collapsed ? $t(item.key) : undefined}
              >
                <span class="nav-icon"><svelte:component this={item.icon} size={16} strokeWidth={1.75} /></span>
                {#if !collapsed}
                  <span class="nav-label">{$t(item.key)}</span>
                {/if}
              </a>
            {/each}
          </div>
        {/each}
      </nav>

      <div class="sidebar-footer">
        <button class="ctrl-btn" on:click={cycleTheme} title={$t(`theme.${$userPref}`)}>
          <span class="ctrl-icon"><svelte:component this={themeIcons[$userPref]} size={14} strokeWidth={1.75} /></span>
          {#if !collapsed}
            <span class="ctrl-label">{$t(`theme.${$userPref}`)}</span>
          {/if}
        </button>

        <button class="ctrl-btn" on:click={toggleLang} title={LANG_NAME[$lang]}>
          <span class="ctrl-icon lang-icon">{LANG_SHORT[$lang]}</span>
          {#if !collapsed}
            <span class="ctrl-label">{LANG_NAME[$lang]}</span>
          {/if}
        </button>

        <button class="ctrl-btn collapse-btn" on:click={toggleSidebar} title={$t(collapsed ? 'nav.expand' : 'nav.collapse')}>
          <span class="ctrl-icon">{#if collapsed}<PanelLeftOpen size={14} strokeWidth={1.75} />{:else}<PanelLeftClose size={14} strokeWidth={1.75} />{/if}</span>
          {#if !collapsed}
            <span class="ctrl-label">{$t('nav.collapse')}</span>
          {/if}
        </button>

        <a class="ctrl-btn" href="https://aiusage.jtanx.com" target="_blank" rel="noopener" title="aiusage.jtanx.com">
          <span class="ctrl-icon"><ExternalLink size={14} strokeWidth={1.75} /></span>
          {#if !collapsed}
            <span class="ctrl-label">{$lang === 'en' ? 'Website' : $lang === 'ja' ? '公式サイト' : '官网'}</span>
          {/if}
        </a>
      </div>

    </div>
  </aside>

  <div class="main-area">

    <header class="mobile-header">
      <button class="hamburger" on:click={toggleMobile}>
        <span></span><span></span><span></span>
      </button>
      <a href="/" class="brand brand-mobile">
        <svg class="brand-logo" width="20" height="20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="currentColor"/>
          <rect x="10" y="38" width="12" height="16" rx="3" fill="white"/>
          <rect x="26" y="26" width="12" height="28" rx="3" fill="white"/>
          <rect x="42" y="14" width="12" height="40" rx="3" fill="white"/>
        </svg>
        <span class="brand-name">AIUsage</span>
      </a>
      <div class="mobile-controls">
        <button class="ctrl-btn" on:click={cycleTheme}>
          <span class="ctrl-icon"><svelte:component this={themeIcons[$userPref]} size={14} strokeWidth={1.75} /></span>
        </button>
        <button class="ctrl-btn" on:click={toggleLang} title={LANG_NAME[$lang]}>
          <span class="ctrl-icon lang-icon">{LANG_SHORT[$lang]}</span>
        </button>
      </div>
    </header>

    <main class="page-content">
      <!--
        Only while someone is looking. Coming back to the app applies the
        update without asking, so this band is what is left: the case where
        swapping the screen would interrupt a person mid-read.
      -->
      {#if $updateReady}
        <div class="update-band" role="status">
          <span>{$t('common.updateReady')}</span>
          <button class="update-btn" on:click={applyUpdate}>{$t('common.updateApply')}</button>
        </div>
      {/if}
      <!-- Above the content, because everything below it is out of date. -->
      <ParseStallBanner />
      {#if routeHidden}
        <!-- Not a 404. The screen exists and works; it was switched off, and
             saying "not found" would send the reader looking for a bug. -->
        <div class="state-msg">
          <h2>{$t('nav.hidden.title')}</h2>
          <p>{$t('nav.hidden.hint')}</p>
          <a class="hidden-route-link" href="/settings">{$t('nav.hidden.action')}</a>
        </div>
      {:else}
        <slot />
      {/if}
    </main>

    <!-- Only drawn by the terminal theme; the CSS hides it everywhere else. -->
    <div class="status-line">
      <span>
        <span class="status-key">aiusage</span>
        <span class="status-sep">│</span>
        {$page.url.pathname}
      </span>
      <span>
        {$t('status.refresh')} {Math.round(refreshMs / 1000)}s
        <span class="status-sep">│</span>
        {statusClock}
      </span>
    </div>

  </div>

</div>
{/if}

<style>
  /* ── Reset & base ─────────────────────────────────────────────────────── */
  :global(*) {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  :global(html) {
    font-size: 18px;
  }
  :global(body) {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    transition: background 0.2s ease, color 0.2s ease;
  }
  :global(:root[data-theme="dark"] body) {
    -webkit-font-smoothing: auto;
    -moz-osx-font-smoothing: auto;
  }

  /* ── Light theme (default) ────────────────────────────────────────────── */
  :global(:root) {
    --bg:               oklch(0.985 0.004 175);
    --surface:          oklch(0.995 0.003 175);
    --raised:           oklch(0.97 0.006 175);
    --hover:            oklch(0.955 0.008 175);
    --sidebar-bg:       oklch(0.98 0.005 175);
    --border-subtle:    oklch(0.92 0.008 175);
    --border-medium:    oklch(0.87 0.01 175);
    --text:             oklch(0.18 0.012 175);
    --text-secondary:   oklch(0.42 0.015 175);
    --text-muted:       oklch(0.6 0.012 175);
    --accent:           oklch(0.55 0.12 175);
    --accent-dim:       oklch(0.55 0.12 175 / 0.1);
    --accent-hover:     oklch(0.50 0.13 175);
    --green:            oklch(0.62 0.17 155);
    --green-dim:        oklch(0.62 0.17 155 / 0.1);
    --blue:             oklch(0.55 0.14 250);
    --blue-dim:         oklch(0.55 0.14 250 / 0.1);
    --purple:           oklch(0.58 0.16 300);
    --purple-dim:       oklch(0.58 0.16 300 / 0.1);
    --rose:             oklch(0.58 0.2 25);
    --rose-dim:         oklch(0.58 0.2 25 / 0.1);
    --badge-override-bg: oklch(0.55 0.12 175 / 0.1);
    --badge-override-fg: oklch(0.55 0.12 175);
    --badge-matched-bg:  oklch(0.62 0.17 155 / 0.1);
    --badge-matched-fg:  oklch(0.62 0.17 155);
    --badge-noprice-bg:  oklch(0.58 0.2 25 / 0.08);
    --badge-noprice-fg:  oklch(0.58 0.2 25);
    --shadow-sm:        0 1px 2px oklch(0 0 0 / 0.05);
    --shadow-md:        0 1px 3px oklch(0 0 0 / 0.08), 0 4px 12px oklch(0 0 0 / 0.04);
    --shadow-lg:        0 4px 8px oklch(0 0 0 / 0.08), 0 12px 32px oklch(0 0 0 / 0.06);
    --overlay:          oklch(0 0 0 / 0.25);
    /*
     * Geist Mono is gone with the CDN it came from. ui-monospace is the
     * platform's own — SF Mono, Cascadia Mono, Roboto Mono — which is a
     * better fit for a tool that sits next to a terminal than a webfont
     * would be, and it is there before the first paint. The Japanese entries
     * follow for the same per-glyph reason as above: a mono stack with no
     * CJK font leaves kana to a fallback nobody chose.
     */
    --mono:             ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Consolas,
                        'Roboto Mono', 'BIZ UDGothic', 'Yu Gothic UI', Meiryo,
                        'Noto Sans Mono CJK JP', monospace;
    --sidebar-width:    180px;
    --sidebar-collapsed: 56px;
    --chart-input:      oklch(0.65 0.14 175);
    --chart-output:     oklch(0.6 0.15 250);
    --chart-cache-read: oklch(0.7 0.1 65);
    --chart-cache-write: oklch(0.65 0.12 310);
    --chart-thinking:   oklch(0.62 0.18 20);
    --chart-total:      oklch(0.55 0.12 175);

    /*
     * ── Shape and type ──────────────────────────────────────────────────
     * Named for what they are on, not what they measure, so a theme that
     * wants square corners sets four values instead of hunting fourteen
     * literals through the pages.
     */
    /*
     * The system's own UI font, and the system's own Japanese font after it.
     *
     * Inter and Geist Mono came from two CDNs, which meant every page load
     * reached out to Google and jsdelivr, the first paint changed typeface
     * once the files arrived, and offline — the case the service worker
     * exists for — the app fell back to whatever the platform had anyway.
     * Using that font from the start costs nothing and is the same picture
     * every time.
     *
     * Latin first, then Japanese: font fallback is per glyph, so Segoe UI
     * draws the Latin on Windows and Yu Gothic UI the kana beside it. Android
     * resolves system-ui to Roboto and the CJK to Noto Sans by itself; the
     * names are listed anyway so the choice does not depend on the platform
     * getting its own fallback right.
     */
    --font-sans:        system-ui, -apple-system, 'Segoe UI', Roboto,
                        'Hiragino Sans', 'Yu Gothic UI', 'Yu Gothic', Meiryo,
                        'Noto Sans JP', 'Noto Sans CJK JP', sans-serif;
    --radius-xs:        3px;
    --radius-badge:     4px;
    --radius-input:     6px;
    --radius-card:      8px;
    --radius-panel:     12px;
    --radius-pill:      999px;
    --border-width:     1px;
    /* Text drawn on top of an accent fill. */
    --on-accent:        oklch(0.99 0.002 175);

    /*
     * ── Status colours ──────────────────────────────────────────────────
     * These lived as literals in twelve page stylesheets, which is why a
     * new theme would have left every warning and error looking like the
     * old one. Each distinct rendered value gets its own name: two roles
     * that happen to share a colour today still need to be able to differ
     * in a theme that treats them differently.
     *
     * Where a page carried its own dark variant it is repeated in the dark
     * block below; where it did not, the light value stands in both — which
     * is what those pages already did.
     */
    --warn-solid:       oklch(0.7 0.15 60);
    --warn-bg:          oklch(0.96 0.02 80);
    --warn-fg:          oklch(0.5 0.14 60);
    --notice-bg:        oklch(0.97 0.03 60);
    --notice-border:    oklch(0.87 0.08 60);
    --notice-fg:        oklch(0.45 0.14 55);
    --danger-fg:        oklch(0.48 0.2 25);
    --danger-bg:        oklch(0.58 0.2 25 / 0.12);
    --danger-solid:     oklch(0.58 0.2 25);
    --danger-border:    oklch(0.7 0.12 25);
    --danger-soft-bg:   oklch(0.58 0.2 25 / 0.08);
    --danger-soft-fg:   oklch(0.42 0.15 25);
    /* The one status colour written as sRGB rather than OKLCH. Left at its
       rendered value; converting it would be a visible change. */
    --danger-plain:     #f87171;
    --info-bg:          oklch(0.55 0.14 250 / 0.12);
    --info-fg:          oklch(0.45 0.14 250);
    --info-solid:       oklch(0.55 0.14 250);
    --success-fg:       oklch(0.5 0.17 155);
    /*
     * Referenced as var(--amber, #f59e0b) in three places while --amber did
     * not exist, so the fallback was what rendered. Defining it changes
     * nothing on screen and makes it reachable from a theme.
     */
    --amber:            #f59e0b;
    /* Two shadows that were written out by hand rather than reused. */
    --shadow-dropdown:  0 1px 3px oklch(0 0 0 / 0.08), 0 4px 12px oklch(0 0 0 / 0.04);
    --shadow-modal:     0 4px 8px oklch(0 0 0 / 0.06), 0 12px 32px oklch(0 0 0 / 0.04);
    --overlay-strong:   oklch(0 0 0 / 0.35);
  }

  /* ── Dark theme ───────────────────────────────────────────────────────── */
  :global(:root[data-theme="dark"]) {
    --bg:               oklch(0.13 0.008 175);
    --surface:          oklch(0.19 0.01 175);
    --raised:           oklch(0.25 0.012 175);
    --hover:            oklch(0.28 0.014 175);
    --sidebar-bg:       oklch(0.11 0.006 175);
    --border-subtle:    oklch(0.30 0.012 175);
    --border-medium:    oklch(0.38 0.014 175);
    --text:             oklch(0.95 0.005 175);
    --text-secondary:   oklch(0.78 0.01 175);
    --text-muted:       oklch(0.64 0.008 175);
    --accent:           oklch(0.72 0.12 175);
    --accent-dim:       oklch(0.72 0.12 175 / 0.15);
    --accent-hover:     oklch(0.78 0.11 175);
    --green:            oklch(0.74 0.16 155);
    --green-dim:        oklch(0.74 0.16 155 / 0.15);
    --blue:             oklch(0.72 0.14 250);
    --blue-dim:         oklch(0.72 0.14 250 / 0.15);
    --purple:           oklch(0.73 0.14 300);
    --purple-dim:       oklch(0.73 0.14 300 / 0.15);
    --rose:             oklch(0.72 0.18 25);
    --rose-dim:         oklch(0.72 0.18 25 / 0.15);
    --badge-override-bg: oklch(0.72 0.12 175 / 0.18);
    --badge-override-fg: oklch(0.72 0.12 175);
    --badge-matched-bg:  oklch(0.74 0.16 155 / 0.18);
    --badge-matched-fg:  oklch(0.74 0.16 155);
    --badge-noprice-bg:  oklch(0.72 0.18 25 / 0.15);
    --badge-noprice-fg:  oklch(0.72 0.18 25);
    --shadow-sm:        0 1px 2px oklch(0 0 0 / 0.3);
    --shadow-md:        0 1px 3px oklch(0 0 0 / 0.4), 0 4px 12px oklch(0 0 0 / 0.2);
    --shadow-lg:        0 4px 8px oklch(0 0 0 / 0.4), 0 12px 32px oklch(0 0 0 / 0.25);
    --overlay:          oklch(0 0 0 / 0.55);
    --chart-input:      oklch(0.74 0.13 175);
    --chart-output:     oklch(0.72 0.14 250);
    --chart-cache-read: oklch(0.78 0.09 65);
    --chart-cache-write: oklch(0.74 0.11 310);
    --chart-thinking:   oklch(0.73 0.17 20);
    --chart-total:      oklch(0.72 0.12 175);

    /*
     * Only the two blocks that had a dark variant of their own. Everything
     * else in the status set inherits the light value, which is exactly what
     * those pages did before — including the error red, which is dark enough
     * to be hard to read on the dark theme. That is a real complaint, but
     * fixing it here would be a visible change, so it stays for now.
     */
    --warn-bg:          oklch(0.22 0.04 60);
    --warn-fg:          oklch(0.75 0.14 60);
    --notice-bg:        oklch(0.2 0.04 55);
    --notice-border:    oklch(0.35 0.1 55);
    --notice-fg:        oklch(0.78 0.14 60);
    /*
     * ── The eight this theme was taking from the light palette ───────────
     *
     * They were inherited, not chosen: nothing in CSS says a theme has to be
     * complete, so eight values from a palette built for white paper were
     * being drawn on a 0.13 ground. scripts/check-theme-vars.cjs is what
     * found them, and it now requires these eight to be here.
     *
     * The five foregrounds were measured rather than eyeballed. Their
     * contrast against what they actually sit on, before:
     *
     *   --danger-fg on --danger-bg            2.37
     *   --danger-soft-fg on --danger-soft-bg  1.92
     *   --info-fg on --info-bg                2.24
     *   --success-fg on --surface             3.50
     *   --on-accent on --accent               2.28
     *
     * against this theme's own --text-muted at 5.52 on the same ground.
     *
     * The values below follow this theme rather than terminal's, which had
     * already solved the same problem with its own numbers. Dark puts its
     * hued colours at 0.72-0.74 and its softer text at 0.75-0.78, so the
     * status foregrounds belong just above that: they are text, and they sit
     * on a tint rather than on the surface itself.
     */
    --danger-fg:        oklch(0.76 0.16 25);
    /* Sits on the fainter tint, so it goes lighter still - the same relation
       the light palette has, pointing the other way. */
    --danger-soft-fg:   oklch(0.82 0.12 25);
    --info-fg:          oklch(0.76 0.11 250);
    --success-fg:       oklch(0.78 0.14 155);
    /*
     * Ink, not paper. The light palette can put near-white on its accent
     * because its accent is dark (0.55); this theme's accent is light (0.72),
     * so the text on it has to flip. It is also the knob of the toggle
     * switch, which becomes a dark knob on a light track - visible for the
     * same reason the text is.
     */
    --on-accent:        oklch(0.17 0.015 175);

    /*
     * The remaining three were not a contrast problem but a contradiction:
     * this theme had already decided that its shadows are four to eight times
     * heavier than the light one's, and that its overlay is 0.55 rather than
     * 0.25 - and then inherited the light values for the two shadows and the
     * overlay that were named separately. --overlay-strong was the plain
     * inversion: at 0.35 it was weaker than the --overlay it is meant to be
     * the strong version of.
     */
    --shadow-dropdown:  0 1px 3px oklch(0 0 0 / 0.4), 0 4px 12px oklch(0 0 0 / 0.2);
    --shadow-modal:     0 4px 8px oklch(0 0 0 / 0.4), 0 12px 32px oklch(0 0 0 / 0.25);
    --overlay-strong:   oklch(0 0 0 / 0.72);
  }

  /*
   * ── 琥珀 (kohaku) ─────────────────────────────────────────────────────
   *
   * A warm, low-blue-light surface for reading at night without switching to
   * a dark page. Light polarity: it is paper, not ink.
   *
   * Every value here was chosen for this theme rather than sampled from
   * anywhere. The only thing borrowed is the idea - warm ground, warm text,
   * blues pulled down in chroma so they stop being the brightest thing on a
   * page full of numbers.
   *
   * Hue sits around 60-85 for everything structural. The status and chart
   * colours keep their hue separation, because a chart with six warm-brown
   * series is unreadable and the whole point of those names is that they can
   * be told apart; what changes is that their chroma comes down to sit inside
   * the same picture rather than on top of it.
   *
   * Geometry and typefaces are not restated - see SHARED in
   * scripts/check-theme-vars.cjs. Everything else is, and that script fails
   * the build if it is not.
   */
  :global(:root[data-theme="kohaku"]) {
    --bg:               oklch(0.962 0.018 82);
    --surface:          oklch(0.984 0.013 82);
    --raised:           oklch(0.943 0.022 80);
    --hover:            oklch(0.922 0.028 78);
    --sidebar-bg:       oklch(0.951 0.021 82);
    --border-subtle:    oklch(0.888 0.026 78);
    --border-medium:    oklch(0.818 0.034 76);

    /* Dark brown rather than black: the contrast is still there, the glare
       is not. */
    --text:             oklch(0.27 0.032 62);
    --text-secondary:   oklch(0.45 0.030 65);
    --text-muted:       oklch(0.60 0.026 68);

    --accent:           oklch(0.58 0.110 68);
    --accent-dim:       oklch(0.58 0.110 68 / 0.12);
    --accent-hover:     oklch(0.52 0.120 66);

    --green:            oklch(0.55 0.110 130);
    --green-dim:        oklch(0.55 0.110 130 / 0.12);
    --blue:             oklch(0.52 0.080 235);
    --blue-dim:         oklch(0.52 0.080 235 / 0.12);
    --purple:           oklch(0.52 0.110 330);
    --purple-dim:       oklch(0.52 0.110 330 / 0.12);
    --rose:             oklch(0.53 0.150 30);
    --rose-dim:         oklch(0.53 0.150 30 / 0.12);

    --badge-override-bg: oklch(0.58 0.110 68 / 0.14);
    --badge-override-fg: oklch(0.48 0.110 66);
    --badge-matched-bg:  oklch(0.55 0.110 130 / 0.14);
    --badge-matched-fg:  oklch(0.45 0.100 130);
    --badge-noprice-bg:  oklch(0.55 0.170 28 / 0.12);
    --badge-noprice-fg:  oklch(0.45 0.160 28);

    /* Warm shadows. Pure black on a warm ground reads as a grey smudge. */
    --shadow-sm:        0 1px 2px oklch(0.30 0.04 60 / 0.08);
    --shadow-md:        0 1px 3px oklch(0.30 0.04 60 / 0.10), 0 4px 12px oklch(0.30 0.04 60 / 0.06);
    --shadow-lg:        0 4px 8px oklch(0.30 0.04 60 / 0.10), 0 12px 32px oklch(0.30 0.04 60 / 0.08);
    --overlay:          oklch(0.25 0.03 60 / 0.28);

    --chart-input:      oklch(0.62 0.120 70);
    --chart-output:     oklch(0.55 0.090 235);
    --chart-cache-read: oklch(0.60 0.100 130);
    --chart-cache-write: oklch(0.55 0.120 330);
    --chart-thinking:   oklch(0.57 0.150 30);
    --chart-total:      oklch(0.45 0.060 65);

    --on-accent:        oklch(0.985 0.010 85);

    --warn-solid:       oklch(0.68 0.140 62);
    --warn-bg:          oklch(0.935 0.040 80);
    --warn-fg:          oklch(0.45 0.120 58);
    --notice-bg:        oklch(0.948 0.050 72);
    --notice-border:    oklch(0.850 0.080 70);
    --notice-fg:        oklch(0.42 0.120 60);

    --danger-fg:        oklch(0.45 0.160 28);
    --danger-bg:        oklch(0.55 0.170 28 / 0.14);
    --danger-solid:     oklch(0.55 0.170 28);
    --danger-border:    oklch(0.70 0.110 28);
    --danger-soft-bg:   oklch(0.55 0.170 28 / 0.09);
    --danger-soft-fg:   oklch(0.40 0.130 28);
    /* The base writes this one in sRGB for a reason that does not apply here:
       nothing is being preserved, so it is stated like everything else. */
    --danger-plain:     oklch(0.62 0.160 28);

    --info-bg:          oklch(0.52 0.080 235 / 0.14);
    --info-fg:          oklch(0.44 0.090 235);
    --info-solid:       oklch(0.52 0.090 235);
    --success-fg:       oklch(0.47 0.100 130);
    --amber:            oklch(0.72 0.140 72);

    --shadow-dropdown:  0 1px 3px oklch(0.30 0.04 60 / 0.10), 0 4px 12px oklch(0.30 0.04 60 / 0.06);
    --shadow-modal:     0 4px 8px oklch(0.30 0.04 60 / 0.08), 0 12px 32px oklch(0.30 0.04 60 / 0.06);
    --overlay-strong:   oklch(0.25 0.03 60 / 0.40);
  }

  /*
   * ── Terminal ──────────────────────────────────────────────────────────
   *
   * A monitoring TUI, not a nostalgia filter: dark blue-green rather than
   * black, and colour used to sort information rather than to decorate.
   * Cyan carries headings, magenta the second level, amber a warning, olive
   * the middle ground and green what is healthy or remaining — the same job
   * those colours do in top or btop, which is where a reader of this page
   * has met them before.
   *
   * Everything is monospace here. That is the point of the theme, and it is
   * the one place the rule from DESIGN.md is deliberately set aside: the
   * grid is the aesthetic, so labels line up with the figures under them.
   *
   * Corners and shadows are zero. Structure is carried by lines: solid rules
   * for boxes, dotted ones for dividers, and bracketed corners on the panels.
   */
  :global(:root[data-theme="terminal"]) {
    --bg:               oklch(0.21 0.028 195);
    --surface:          oklch(0.25 0.032 195);
    --raised:           oklch(0.29 0.036 195);
    --hover:            oklch(0.33 0.04 195);
    --sidebar-bg:       oklch(0.18 0.024 195);
    --border-subtle:    oklch(0.40 0.045 195);
    --border-medium:    oklch(0.55 0.07 195);
    --text:             oklch(0.90 0.03 175);
    --text-secondary:   oklch(0.78 0.04 175);
    --text-muted:       oklch(0.62 0.04 190);
    /* Cyan is the interface's own colour: headings, links, the caret. */
    --accent:           oklch(0.82 0.13 200);
    --accent-dim:       oklch(0.82 0.13 200 / 0.16);
    --accent-hover:     oklch(0.90 0.13 200);
    /* Green reads as "fine, and this much left". */
    --green:            oklch(0.80 0.19 145);
    --green-dim:        oklch(0.80 0.19 145 / 0.16);
    /* Magenta is the second heading level, not an alert. */
    --blue:             oklch(0.74 0.19 330);
    --blue-dim:         oklch(0.74 0.19 330 / 0.16);
    --purple:           oklch(0.74 0.19 330);
    --purple-dim:       oklch(0.74 0.19 330 / 0.16);
    --rose:             oklch(0.72 0.20 25);
    --rose-dim:         oklch(0.72 0.20 25 / 0.16);
    --badge-override-bg: oklch(0.82 0.13 200 / 0.16);
    --badge-override-fg: oklch(0.82 0.13 200);
    --badge-matched-bg:  oklch(0.80 0.19 145 / 0.16);
    --badge-matched-fg:  oklch(0.80 0.19 145);
    --badge-noprice-bg:  oklch(0.80 0.15 75 / 0.16);
    --badge-noprice-fg:  oklch(0.80 0.15 75);
    /* No shadows. Depth is a painted illusion and this surface has none. */
    --shadow-sm:        none;
    --shadow-md:        none;
    --shadow-lg:        none;
    --shadow-dropdown:  none;
    --shadow-modal:     none;
    --overlay:          oklch(0.12 0.02 195 / 0.75);
    --overlay-strong:   oklch(0.12 0.02 195 / 0.85);
    /* One face for everything. */
    --font-sans:        var(--mono);
    /* Square. */
    --radius-xs:        0;
    --radius-badge:     0;
    --radius-input:     0;
    --radius-card:      0;
    --radius-panel:     0;
    --radius-pill:      0;
    --on-accent:        oklch(0.16 0.02 195);
    /* Amber warns; olive is the step before it. */
    --warn-solid:       oklch(0.80 0.15 75);
    --warn-bg:          oklch(0.80 0.15 75 / 0.14);
    --warn-fg:          oklch(0.84 0.14 80);
    --notice-bg:        oklch(0.74 0.12 110 / 0.14);
    --notice-border:    oklch(0.74 0.12 110);
    --notice-fg:        oklch(0.80 0.12 110);
    --danger-fg:        oklch(0.76 0.20 25);
    --danger-bg:        oklch(0.72 0.20 25 / 0.18);
    --danger-solid:     oklch(0.72 0.20 25);
    --danger-border:    oklch(0.72 0.20 25);
    --danger-soft-bg:   oklch(0.72 0.20 25 / 0.12);
    --danger-soft-fg:   oklch(0.80 0.18 25);
    --danger-plain:     oklch(0.76 0.20 25);
    --info-bg:          oklch(0.82 0.13 200 / 0.14);
    --info-fg:          oklch(0.82 0.13 200);
    --info-solid:       oklch(0.82 0.13 200);
    --success-fg:       oklch(0.80 0.19 145);
    --amber:            oklch(0.80 0.15 75);
    /* Chart series, ordered so neighbours stay distinguishable. */
    --chart-input:      oklch(0.82 0.13 200);
    --chart-output:     oklch(0.74 0.19 330);
    --chart-cache-read: oklch(0.80 0.15 75);
    --chart-cache-write: oklch(0.74 0.12 110);
    --chart-thinking:   oklch(0.76 0.20 25);
    --chart-total:      oklch(0.80 0.19 145);
  }

  /*
   * ── Terminal: the parts a colour cannot carry ─────────────────────────
   *
   * Everything below is scoped to the theme, so no other theme is touched by
   * it. This is the boundary the token file could not cross: brackets,
   * dotted rules and a status line are shapes, not values.
   */

  /* One face, everywhere. */
  :global(:root[data-theme="terminal"] body),
  :global(:root[data-theme="terminal"] button),
  :global(:root[data-theme="terminal"] input),
  :global(:root[data-theme="terminal"] select),
  :global(:root[data-theme="terminal"] textarea) {
    font-family: var(--mono);
  }

  /*
   * Bracketed corners, drawn as eight background slices rather than extra
   * elements — an element has two pseudo-elements and a box has four corners.
   */
  :global(:root[data-theme="terminal"] .card) {
    /* The title above is positioned against this. */
    position: relative;
    border: var(--border-width) solid var(--border-subtle);
    /*
     * The card clips its overflow to hold rounded corners. There are no
     * rounded corners here, and the title has to sit on the top rule, so the
     * vertical clip has to go — otherwise the title is cut in half.
     *
     * The horizontal one stays. Dropping both is what broke /tokens and
     * /cost: their gridlines are drawn far past the chart and rely on this
     * card to cut them off, so without it a 360px phone got a 10,093px page
     * and both screens were squeezed into the left quarter. Clipping only
     * the axis the title does not need buys back nothing and costs nothing —
     * clip stops at the same padding box that overflow: hidden did, so the
     * gridlines end exactly where they do in the other themes.
     *
     * Wide tables are unaffected either way: they have carried their own
     * scroller since 8-B-2.
     */
    overflow-x: clip;
    overflow-y: visible;
    /*
     * overflow: hidden also made the card a scroll container, and a scroll
     * container that is a grid item gets an automatic minimum size of zero.
     * clip does not, so on /overview the cards grew to their tables'
     * min-content width and pushed the page 96px past the phone. Saying it
     * outright restores what the old value was doing by accident.
     */
    min-width: 0;
    background:
      linear-gradient(var(--accent), var(--accent)) 0 0 / 12px 2px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 0 0 / 2px 12px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 100% 0 / 12px 2px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 100% 0 / 2px 12px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 0 100% / 12px 2px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 0 100% / 2px 12px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 100% 100% / 12px 2px no-repeat,
      linear-gradient(var(--accent), var(--accent)) 100% 100% / 2px 12px no-repeat,
      var(--surface);
  }

  /*
   * The panel's title sits on its top rule, the way a boxed TUI names its
   * panes. Lifted by the card's own padding plus half a line, and the space
   * it vacated is given back so nothing below shifts.
   */
  /*
   * Taken out of the flow rather than pulled up through it. Lifting it with
   * a negative margin dragged everything after it along, and on a card whose
   * header also holds tabs the list rose over the top of them. Out of flow,
   * the title is only a label on the rule and the card lays out as if it
   * were not there.
   */
  :global(:root[data-theme="terminal"] .card > .section-title:first-child),
  :global(:root[data-theme="terminal"] .card > .group-title:first-child),
  :global(:root[data-theme="terminal"] .card > .card-header:first-child > .section-title) {
    position: absolute;
    top: -0.62em;
    left: 0.9rem;
    margin: 0;
    padding: 0 0.5rem;
    background: var(--surface);
    color: var(--accent);
  }

  /* The small stat boxes are boxes too, without the ceremony of brackets. */
  :global(:root[data-theme="terminal"] .hero-card),
  :global(:root[data-theme="terminal"] .token-item) {
    border: var(--border-width) solid var(--border-subtle);
  }

  /* The second level of heading, in magenta. */
  :global(:root[data-theme="terminal"] h1),
  :global(:root[data-theme="terminal"] .page-header h1) {
    color: var(--accent);
  }
  :global(:root[data-theme="terminal"] h2),
  :global(:root[data-theme="terminal"] h3) {
    color: var(--purple);
  }

  /* Dotted rules everywhere a solid one was only separating rows. */
  :global(:root[data-theme="terminal"] td),
  :global(:root[data-theme="terminal"] th) {
    border-bottom-style: dotted;
    border-bottom-color: var(--border-medium);
  }
  :global(:root[data-theme="terminal"] .filter-bar) {
    border: var(--border-width) dotted var(--border-subtle);
    background: transparent;
  }

  /*
   * The status line.
   *
   * A TUI ends in one, and this one says only things that are true: which
   * screen is open, how often the page refreshes itself, and the clock. No
   * "Ctrl-C quit" — the key does nothing in a browser, and a status line
   * that lies about its own keys is the one part of the imitation that would
   * actually mislead someone.
   */
  /* Quiet: a new version is good news and nothing is wrong. It asks
     rather than announces, because the reader is mid-something. */
  .update-band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: var(--raised);
    color: var(--text-secondary);
    border-radius: var(--radius-card);
    padding: 0.55rem 0.75rem;
    margin-bottom: 1rem;
    font-size: 0.8125rem;
  }
  .update-btn {
    flex-shrink: 0;
    background: var(--accent);
    color: var(--surface);
    border: none;
    border-radius: var(--radius-card);
    padding: 0.3rem 0.7rem;
    font-size: 0.75rem;
    cursor: pointer;
  }

  .status-line {
    display: none;
  }
  :global(:root[data-theme="terminal"]) .status-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.3rem 1rem;
    border-top: var(--border-width) solid var(--border-subtle);
    background: var(--sidebar-bg);
    color: var(--text-muted);
    font-family: var(--mono);
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
  }
  .status-line .status-key {
    color: var(--accent);
  }
  .status-line .status-sep {
    color: var(--border-medium);
    padding: 0 0.5rem;
  }

  /* ── App shell ────────────────────────────────────────────────────────── */
  .app {
    display: flex;
    min-height: 100vh;
  }

  .public-shell {
    min-height: 100vh;
    padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 2.5rem;
  }

  .public-header {
    max-width: 1180px;
    margin: 0 auto 1.25rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .public-page-content {
    min-height: calc(100vh - 5.25rem);
  }

  .public-page-inner {
    max-width: 1180px;
    margin: 0 auto;
  }

  .public-unlock {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: 2.5rem;
    padding: 0 0.85rem;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-sm);
    font: inherit;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
  }

  .public-unlock:hover {
    border-color: var(--border-medium);
    color: var(--accent);
  }

  .public-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  /* The one control on this page that has to look like the way forward. */
  .public-signin {
    height: 2.5rem;
    padding: 0 1rem;
    border: var(--border-width) solid var(--accent);
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--on-accent);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 700;
    cursor: pointer;
  }

  .public-signin:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .public-lang {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    min-width: 2.5rem;
    height: 2.5rem;
    padding: 0;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-pill);
    background: var(--surface);
    color: var(--text-secondary);
    box-shadow: var(--shadow-sm);
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 700;
    cursor: pointer;
  }

  .public-lang:hover {
    border-color: var(--border-medium);
    color: var(--accent);
  }

  .auth-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: var(--overlay);
    backdrop-filter: blur(8px);
  }

  .auth-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 510;
    transform: translate(-50%, -50%);
  }

  .auth-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-pill);
    border: var(--border-width) solid var(--border-subtle);
    background: var(--raised);
    color: var(--text-secondary);
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
  }

  .auth-close:hover {
    color: var(--text);
    border-color: var(--border-medium);
  }

  .auth-page {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background:
      radial-gradient(circle at top left, var(--accent-dim), transparent 30rem),
      var(--bg);
  }

  .auth-card {
    width: min(100%, 380px);
    background: var(--surface);
    border: var(--border-width) solid var(--border-subtle);
    border-radius: 1.25rem;
    box-shadow: var(--shadow-lg);
    padding: 1.5rem;
  }

  .auth-brand {
    width: fit-content;
    padding: 0;
    margin-bottom: 1.25rem;
  }

  .auth-card h1 {
    font-size: 1.45rem;
    letter-spacing: -0.03em;
    margin-bottom: 0.35rem;
  }

  .auth-card p {
    color: var(--text-secondary);
    margin-bottom: 1.25rem;
    line-height: 1.5;
  }

  .auth-card form {
    display: grid;
    gap: 0.75rem;
  }

  .auth-card input {
    width: 100%;
    height: 2.75rem;
    border-radius: 0.75rem;
    border: var(--border-width) solid var(--border-medium);
    background: var(--raised);
    color: var(--text);
    padding: 0 0.9rem;
    font: inherit;
    outline: none;
  }

  .auth-card input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }

  .auth-card button {
    height: 2.75rem;
    border: 0;
    border-radius: 0.75rem;
    background: var(--accent);
    color: white;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  .auth-card button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .auth-card .auth-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border-radius: var(--radius-pill);
    border: var(--border-width) solid var(--border-subtle);
    background: var(--raised);
    color: var(--text-secondary);
    font-size: 1.25rem;
    font-weight: 400;
    line-height: 1;
  }

  .auth-card .auth-close:hover {
    color: var(--text);
    border-color: var(--border-medium);
  }

  .auth-error {
    margin-top: 0.9rem;
    color: var(--rose);
    font-size: 0.9rem;
  }

  .auth-home {
    display: inline-block;
    margin-top: 1rem;
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.9rem;
  }

  .auth-home:hover {
    color: var(--accent);
  }

  .auth-loading {
    color: var(--text-secondary);
  }

  /* ── Sidebar ──────────────────────────────────────────────────────────── */
  .sidebar {
    width: var(--sidebar-width);
    min-height: 100vh;
    background: var(--sidebar-bg);
    position: fixed;
    top: 0;
    left: 0;
    z-index: 200;
    transition: width 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .app.collapsed .sidebar {
    width: var(--sidebar-collapsed);
  }

  .sidebar-inner {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* Brand */
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem 0.875rem;
    text-decoration: none;
    flex-shrink: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .brand-logo {
    display: block;
    color: var(--accent);
    flex-shrink: 0;
    width: 20px;
    height: 20px;
  }
  .brand-name {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 0.8125rem;
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .brand-mobile {
    padding: 0;
  }

  /* Nav */
  .sidebar-nav {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0.5rem 0;
    scrollbar-width: thin;
    scrollbar-color: var(--border-subtle) transparent;
  }

  .nav-group {
    margin-bottom: 0.125rem;
  }

  .group-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 0.5rem 0.875rem 0.25rem;
    white-space: nowrap;
    overflow: hidden;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.875rem;
    margin: 0 0.375rem;
    text-decoration: none;
    color: var(--text-secondary);
    font-size: 0.8125rem;
    font-weight: 500;
    border-radius: var(--radius-input);
    transition: color 0.12s, background 0.12s;
    position: relative;
    white-space: nowrap;
    overflow: hidden;
  }
  .nav-item:hover {
    color: var(--text);
    background: var(--hover);
  }
  .nav-item.active {
    color: var(--text);
    background: var(--accent-dim);
    font-weight: 600;
  }

  .nav-icon {
    width: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .nav-label {
    flex: 1;
    min-width: 0;
  }

  /* Sidebar footer */
  .sidebar-footer {
    padding: 0.5rem 0;
    border-top: var(--border-width) solid var(--border-subtle);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.875rem;
    margin: 0 0.375rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-input);
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
    white-space: nowrap;
    overflow: hidden;
    width: calc(100% - 0.75rem);
    text-align: left;
  }
  .ctrl-btn:hover {
    color: var(--text);
    background: var(--hover);
  }
  .ctrl-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .ctrl-icon {
    width: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .lang-icon {
    font-size: 0.75rem;
    font-weight: 700;
  }
  .ctrl-label {
    font-size: 0.75rem;
    font-weight: 550;
    letter-spacing: 0.02em;
    flex: 1;
  }
  .collapse-btn { margin-top: 0.125rem; }

  /* ── Main area ────────────────────────────────────────────────────────── */
  .main-area {
    flex: 1;
    min-width: 0;
    margin-left: var(--sidebar-width);
    transition: margin-left 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .app.collapsed .main-area {
    margin-left: var(--sidebar-collapsed);
  }

  /* Mobile top bar */
  .mobile-header {
    display: none;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    background: var(--surface);
    border-bottom: var(--border-width) solid var(--border-subtle);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .hamburger {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .hamburger span {
    display: block;
    width: 16px;
    height: 1.5px;
    background: var(--text-secondary);
    border-radius: 1px;
  }

  .mobile-controls {
    margin-left: auto;
    display: flex;
    gap: 0.125rem;
  }
  .mobile-controls .ctrl-btn {
    padding: 0.25rem 0.5rem;
    width: auto;
    margin: 0;
  }

  /* Page content */
  .page-content {
    flex: 1;
    min-width: 0;
    padding: 2rem 2.5rem;
    width: 100%;
    animation: fadeIn 0.2s cubic-bezier(0.25, 0.1, 0.25, 1);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* Mobile backdrop */
  .mobile-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--overlay);
    z-index: 190;
  }

  /* ── Global design tokens ─────────────────────────────────────────────── */
  :global(.card) {
    background: var(--surface);
    border-radius: var(--radius-card);
    padding: 1.25rem;
    transition: background 0.2s;
    overflow: hidden;
  }

  /*
   * .card clips its overflow so the rounded corners hold, which silently cut
   * the right-hand columns off every wide table on a phone — and because it
   * clips rather than scrolls, those columns could not be reached at all.
   * Wrapping the table in its own scroller fixes that without touching the
   * card, so no column is ever hidden and the desktop layout is untouched.
   *
   * The edge cue is the Komarov shadow trick: two covers painted in the card
   * colour scroll away with the content (attachment: local) and uncover two
   * shadows pinned to the visible edges (attachment: scroll). When nothing
   * overflows, both covers sit on top of both shadows and nothing shows —
   * which is why a desktop-width table looks exactly as it did before.
   *
   * The shadow is --border-medium rather than a black overlay: black is
   * invisible against the dark theme's surface, and the edge cue has to
   * work in both themes. Both colours are existing tokens; no new design
   * value is introduced.
   */
  :global(.table-scroll) {
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border-medium) transparent;
    background:
      linear-gradient(to right, var(--surface) 40%, transparent) 0 0 / 24px 100% no-repeat local,
      linear-gradient(to left, var(--surface) 40%, transparent) 100% 0 / 24px 100% no-repeat local,
      radial-gradient(farthest-side at 0 50%, var(--border-medium), transparent) 0 0 / 14px 100% no-repeat scroll,
      radial-gradient(farthest-side at 100% 50%, var(--border-medium), transparent) 100% 0 / 14px 100% no-repeat scroll;
  }

  /* Once the table can scroll there is no reason to squeeze a header into a
     narrow column, and squeezing one broke Japanese labels a character at a
     time — "キャッシュ読み取り" came out as a vertical strip of glyphs. On a
     desktop the headers already fit on one line, so nothing changes there. */
  :global(.table-scroll th) {
    white-space: nowrap;
  }

  :global(.section-title) {
    font-size: 0.75rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  :global(.page-header) {
    margin-bottom: 1.5rem;
  }
  :global(.page-header h1) {
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.01em;
    margin-bottom: 0.25rem;
  }
  :global(.page-header p) {
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }
  :global(.page-header-row) {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  :global(.filter-bar) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    padding: 0.5rem 0.75rem;
    background: var(--raised);
    border-radius: var(--radius-card);
  }

  :global(table) {
    width: 100%;
    border-collapse: collapse;
  }
  :global(th) {
    font-size: 0.75rem;
    font-weight: 550;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    text-align: left;
    padding: 0.5rem 0.75rem;
    border-bottom: var(--border-width) solid var(--border-subtle);
  }
  :global(td) {
    padding: 0.5rem 0.75rem;
    border-bottom: var(--border-width) solid var(--border-subtle);
    font-size: 0.8125rem;
    color: var(--text-secondary);
    transition: color 0.2s;
  }
  :global(tbody tr) {
    transition: background 0.1s;
  }
  :global(tbody tr:hover) {
    background: var(--hover);
  }

  :global(.mono) { font-family: var(--mono); }
  :global(.accent) { color: var(--accent); }
  :global(.green) { color: var(--green); }
  :global(.blue) { color: var(--blue); }
  :global(.purple) { color: var(--purple); }

  :global(.state-msg) {
    text-align: center;
    padding: 4rem 2rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  :global(.state-msg h2) {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
  }
  :global(.state-msg.error) { color: var(--rose); }

  /* The way back on from a screen that was switched off. */
  .hidden-route-link {
    display: inline-block;
    margin-top: 1rem;
    padding: 0.5rem 1rem;
    border: var(--border-width) solid var(--border-subtle);
    border-radius: var(--radius-input);
    background: var(--raised);
    color: var(--accent);
    text-decoration: none;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .hidden-route-link:hover {
    border-color: var(--accent);
  }

  :global(button) { font-family: var(--font-sans); }

  /* ── Reduced motion ───────────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    :global(*) {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* ── Mobile overrides ─────────────────────────────────────────────────── */
  @media (max-width: 800px) {
    .sidebar {
      transform: translateX(-100%);
      width: var(--sidebar-width) !important;
      box-shadow: var(--shadow-lg);
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .main-area {
      margin-left: 0 !important;
    }
    .mobile-header {
      display: flex;
    }
    .mobile-backdrop {
      display: block;
    }
    .page-content {
      padding: 1.25rem 1rem;
    }
    .public-shell {
      padding: 1rem 0.875rem 1.5rem;
    }
    .public-header {
      margin-bottom: 1rem;
    }
    .public-unlock {
      height: 2.25rem;
      padding: 0 0.75rem;
      font-size: 0.8125rem;
    }
    .public-lang {
      min-width: 2.25rem;
      height: 2.25rem;
      padding: 0 0.625rem;
    }

    /* Global mobile font size minimums */
    :global(.mono),
    :global(th),
    :global(td),
    :global(.section-title),
    :global(.group-label),
    :global(.ctrl-label),
    :global(.ctrl-icon) {
      font-size: 0.75rem !important;
    }
    :global(.hero-label),
    :global(.token-label),
    :global(.stat-label) {
      font-size: 0.75rem !important;
    }
    :global(.legend-item),
    :global(.tc-rank) {
      font-size: 0.75rem !important;
    }
  }

  @media (min-width: 801px) {
    .mobile-backdrop { display: none !important; }
  }

  /*
   * ── Touch targets ─────────────────────────────────────────────────────
   * Everything here is gated on a coarse pointer, so a mouse-driven browser
   * at any width — including a narrow desktop window — renders exactly as it
   * did before. Only the icon's hit area grows; the drawn size is untouched.
   *
   * This is deliberately limited to controls. Links sitting inside body text
   * (the per-row "show body" links on /notifications, the cloud-setup links
   * in settings) are left alone: padding them out to 44px would space a
   * hundred-row list into something you cannot read, and the surrounding
   * line height already keeps them apart.
   */
  @media (pointer: coarse) {
    /* The only way to open navigation on a phone was a 24x19px button. */
    .hamburger {
      min-width: 44px;
      min-height: 44px;
      align-items: center;
      justify-content: center;
    }
    .nav-item {
      min-height: 44px;
    }
    .ctrl-btn {
      min-height: 44px;
    }
    .mobile-controls .ctrl-btn {
      min-width: 44px;
      justify-content: center;
    }

    /* Shared page controls. Global selectors because each of these lives in
       a component whose styles are scoped, and the policy belongs in one
       place rather than copied into six files. */
    :global(.date-range button),
    :global(.date-range select),
    :global(.date-range input),
    :global(.tool-btn),
    :global(.device-selector select),
    :global(.field-input),
    :global(.card-tab),
    :global(.pagination button),
    :global(.btn-save),
    :global(.btn-ghost),
    :global(.cfg-btn),
    :global(.now-btn),
    :global(.mode-btn),
    :global(.refresh-btn),
    :global(.type-tabs button),
    :global(.btn-sm),
    :global(.toggle-btn),
    :global(.model-filter-input),
    :global(.not-found-toggle) {
      min-height: 44px;
    }
    /* /leaderboard's two controls set their own min-height at a higher
       specificity than a :global() selector can reach, so they are raised
       in that page's own stylesheet instead. */
    /* Height alone does not help a checkbox; it is the box that is small. */
    :global(.toggle input[type='checkbox']),
    :global(.show-all input[type='checkbox']) {
      width: 22px;
      height: 22px;
    }
    :global(.toggle),
    :global(.show-all) {
      min-height: 44px;
    }
  }
</style>
