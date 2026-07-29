/**
 * Refuse the process-wide Node.js escape hatch that disables TLS certificate
 * validation. Enterprise/private CAs remain supported through
 * NODE_EXTRA_CA_CERTS.
 */
export function enforceSecureTlsEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') return false
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  return true
}
