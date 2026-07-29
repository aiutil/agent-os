import { describe, expect, it } from 'vitest'
import { enforceSecureTlsEnvironment } from '../src/main/secure-tls-environment'

describe('secure TLS environment', () => {
  it('removes the process-wide certificate validation bypass', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      NODE_EXTRA_CA_CERTS: '/private/corporate-ca.pem'
    }

    expect(enforceSecureTlsEnvironment(env)).toBe(true)
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined()
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/private/corporate-ca.pem')
  })

  it('does not mutate safe values', () => {
    const unset: NodeJS.ProcessEnv = {}
    const enabled: NodeJS.ProcessEnv = { NODE_TLS_REJECT_UNAUTHORIZED: '1' }

    expect(enforceSecureTlsEnvironment(unset)).toBe(false)
    expect(unset).toEqual({})
    expect(enforceSecureTlsEnvironment(enabled)).toBe(false)
    expect(enabled.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1')
  })
})
