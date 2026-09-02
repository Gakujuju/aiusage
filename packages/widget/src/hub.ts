/**
 * Everything this widget knows, it now asks the hub for.
 *
 * It used to open ~/.aiusage/cache.db with better-sqlite3. That meant a
 * native binding, which meant an Electron ABI, which meant a rebuild step -
 * and that rebuild recompiled the better-sqlite3 the CLI shares, took the
 * CLI down on a machine that was collecting data, and did not put it back.
 * Fetching removes the whole class: no binding, no ABI, no compiler.
 *
 * One path for every machine, including the hub. The hub logs in to its own
 * 127.0.0.1 rather than reading the file next to it - a second path would be
 * a second set of rules about staleness and shape, and the two would
 * eventually disagree in front of the person reading the panel.
 */

export type HubFailure =
  /** No answer at all: asleep, off the network, wrong port. */
  | 'unreachable'
  /** Answered, and said no. The password is wrong or has changed. */
  | 'unauthorized'
  /** Answered with something this does not understand. */
  | 'unexpected'

export class HubError extends Error {
  constructor(readonly kind: HubFailure, message: string) {
    super(message)
    this.name = 'HubError'
  }
}

/** Long enough for a sleepy machine on a tailnet, short enough to notice. */
const TIMEOUT_MS = 8000

export interface HubOptions {
  /** Origin, e.g. http://127.0.0.1:3847 - no trailing slash. */
  url: string
  /** The dashboard password, or null when the hub has none set. */
  password: string | null
  fetchImpl?: typeof fetch
}

/**
 * A logged-in connection to one hub.
 *
 * The cookie lives here and nowhere else. It is not written to disk: it
 * expires in a week and can be made again from the password at any time, so
 * storing it would add a second secret on disk to save one request.
 */
export class Hub {
  private cookie: string | null = null

  constructor(private readonly options: HubOptions) {}

  get url(): string {
    return this.options.url
  }

  /**
   * @param path e.g. '/api/quotas'
   *
   * Logs in on demand, and once more if the answer is 401 - a cookie that
   * expired mid-session should not need the user to do anything.
   */
  async get<T>(path: string): Promise<T> {
    let response = await this.send(path)
    if (response.status === 401) {
      this.cookie = null
      await this.login()
      response = await this.send(path)
    }

    if (response.status === 401) {
      throw new HubError('unauthorized', 'the hub rejected the dashboard password')
    }
    if (!response.ok) {
      throw new HubError('unexpected', `the hub answered ${response.status} for ${path}`)
    }

    try {
      return await response.json() as T
    } catch {
      throw new HubError('unexpected', `the hub answered ${path} with something that is not JSON`)
    }
  }

  private async send(path: string): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.cookie) headers.Cookie = this.cookie
    return this.request(path, { headers })
  }

  private async login(): Promise<void> {
    if (this.options.password == null) return

    const response = await this.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.options.password }),
    })

    if (response.status === 401) {
      throw new HubError('unauthorized', 'the hub rejected the dashboard password')
    }
    if (!response.ok) {
      throw new HubError('unexpected', `the hub answered ${response.status} to a login`)
    }

    const setCookie = response.headers.get('set-cookie')
    /*
     * A hub with no password set answers a login without setting anything,
     * and every later request works without a cookie. That is a normal
     * arrangement, not a failure.
     */
    if (setCookie) this.cookie = setCookie.split(';')[0]
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const call = this.options.fetchImpl ?? fetch
    try {
      return await call(`${this.options.url}${path}`, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      /*
       * Every reason a request never arrives lands here - refused, timed
       * out, DNS, a tailnet that is down - and they are one situation to the
       * person looking at the panel: the hub cannot be reached.
       */
      throw new HubError('unreachable', error instanceof Error ? error.message : String(error))
    }
  }
}
