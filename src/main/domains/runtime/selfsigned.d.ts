declare module 'selfsigned' {
  interface SelfSignedAttr {
    name: string
    value: string
  }
  interface SelfSignedOptions {
    days?: number
    keySize?: number
    algorithm?: string
    extensions?: unknown[]
  }
  interface SelfSignedPems {
    private: string
    public: string
    cert: string
  }
  export function generate(attrs?: SelfSignedAttr[], options?: SelfSignedOptions): SelfSignedPems
  const _default: { generate: typeof generate }
  export default _default
}
