/**
 * Classifying why a quota query failed.
 *
 * The CLI's quota reader reports `credentialStatus: 'valid'` for any failure
 * that is not specifically a credential problem — including a dead network —
 * because from its point of view the credentials really are fine. That makes
 * credentialStatus alone useless for telling a user whether to re-authenticate
 * or check their wifi, so the error text has to be read too.
 *
 * Kept as a pure function over a structural type so core does not depend on
 * the CLI package.
 */

export type QuotaErrorKind = '' | 'auth' | 'network' | 'api' | 'parse'

/** The parts of the CLI's QuotaResult this needs. */
export interface QuotaErrorInput {
  credentialStatus?: string | null
  success?: boolean
  error?: string | null
}

export function classifyQuotaError(result: QuotaErrorInput | null | undefined): QuotaErrorKind {
  if (!result) return ''
  if (result.success === true) return ''

  if (result.credentialStatus === 'expired') return 'auth'
  if (result.credentialStatus === 'parse_error') return 'parse'

  const error = typeof result.error === 'string' ? result.error : ''
  // The exact prefix the quota reader puts on a failed fetch().
  if (error.includes('Network error')) return 'network'
  if (error) return 'api'

  // not_found, and any other failure that carries no error text — nothing
  // went wrong, the tool simply is not set up here.
  return ''
}
