import { PKCECodePair, createPKCECodes } from './pkce'

import jwtDecode from 'jwt-decode'
import { toUrlEncoded } from './util'

export interface AuthServiceProps {
  clientId: string
  clientSecret?: string
  contentType?: string
  location: Location
  provider: string
  authorizeEndpoint?: string
  tokenEndpoint?: string
  logoutEndpoint?: string
  audience?: string
  redirectUri?: string
  scopes: string[]
  prompts?: string[]
  autoRefresh?: boolean
  refreshSlack?: number
  localStoragePrefix?: string
}

export interface AuthTokens {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at?: number // calculated on login
  token_type: string
}

export interface TokenRequestBody {
  clientId: string
  grantType: string
  redirectUri?: string
  refresh_token?: string
  clientSecret?: string
  code?: string
  codeVerifier?: string
}

export interface IdTokenPayload {
  iss?: string
  sub?: string
  aud?: string | string[]
  jti?: string
  nbf?: number
  exp?: number
  iat?: number
  [propName: string]: unknown
}

export class AuthService<IdTokenType = IdTokenPayload> {
  props: AuthServiceProps
  timeout?: number

  constructor(props: AuthServiceProps) {
    this.props = props
    const code = this.getCodeFromLocation(window.location)
    if (code !== null) {
      this.fetchToken(code)
        .then(() => {
          this.restoreUri()
        })
        .catch((e) => {
          this.removeItem('pkce')
          this.removeItem('auth')
          this.removeCodeFromLocation()
          console.warn({ e })
        })
    } else if (this.props.autoRefresh) {
      this.startTimer()
    }
  }

  getUser(): IdTokenType {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated')
    }
    const authTokens = this.getAuthTokens()
    if (!authTokens.id_token) {
      throw new Error('No id token')
    } else {
      return jwtDecode(authTokens.id_token)
    }
  }

  private getCodeFromLocation(location: Location): string | null {
    const split = location.toString().split('?')
    if (split.length < 2) {
      return null
    }
    const pairs = split[1].split('&')
    for (const pair of pairs) {
      const [key, value] = pair.split('=')
      if (key === 'code') {
        return decodeURIComponent(value || '')
      }
    }
    return null
  }

  private removeCodeFromLocation(): void {
    const [base, search] = window.location.href.split('?')
    if (!search) {
      return
    }
    const newSearch = search
      .split('&')
      .map((param) => param.split('='))
      .filter(([key]) => key !== 'code')
      .map((keyAndVal) => keyAndVal.join('='))
      .join('&')
    window.history.replaceState(
      window.history.state,
      'null',
      base + (newSearch.length ? `?${newSearch}` : '')
    )
  }

  getPkce(): PKCECodePair {
    const pkce = this.getItem('pkce')
    if (null === pkce) {
      throw new Error('PKCE pair not found in local storage')
    } else {
      return JSON.parse(pkce)
    }
  }

  setAuthTokens(auth: AuthTokens): void {
    const { refreshSlack = 5 } = this.props
    const now = new Date().getTime()
    auth.expires_at = now + (auth.expires_in + refreshSlack) * 1000
    this.setItem('auth', JSON.stringify(auth))
  }

  getAuthTokens(): AuthTokens {
    const auth = this.getItem('auth')
    if (null === auth) {
      throw new Error('Auth not found in local storage')
    } else {
      return JSON.parse(auth)
    }
  }

  isPending(): boolean {
    return this.haveItem('pkce') && !this.isAuthenticated()
  }

  isAuthenticated(): boolean {
    return this.haveItem('auth')
  }

  async logout(shouldEndSession = false): Promise<boolean> {
    this.removeItem('pkce')
    this.removeItem('auth')
    if (shouldEndSession) {
      const { clientId, provider, logoutEndpoint, redirectUri } = this.props
      const query = {
        client_id: clientId,
        post_logout_redirect_uri: redirectUri
      }
      const url = `${logoutEndpoint || `${provider}/logout`}?${toUrlEncoded(
        query
      )}`
      window.location.replace(url)
      return true
    } else {
      window.location.reload()
      return true
    }
  }

  async login(): Promise<void> {
    return this.authorize()
  }

  // this will do a full page reload to the OAuth2 provider's login page
  async authorize(): Promise<void> {
    const {
      clientId,
      provider,
      authorizeEndpoint,
      redirectUri,
      scopes,
      prompts,
      audience
    } = this.props

    const pkce = await createPKCECodes()
    this.setItem('pkce', JSON.stringify(pkce))
    this.setItem('preAuthUri', location.href)
    this.removeItem('auth')
    const codeChallenge = pkce.codeChallenge

    const query = {
      clientId,
      scope: scopes.join(' '),
      prompt: prompts?.length ? prompts.join(' ') : undefined,
      responseType: 'code',
      redirectUri,
      ...(audience && { audience }),
      codeChallenge,
      codeChallengeMethod: 'S256'
    }

    const url = `${authorizeEndpoint || `${provider}/authorize`}?${toUrlEncoded(
      query
    )}`
    window.location.replace(url)
  }

  // this happens after a full page reload. Read the code from localstorage
  async fetchToken(code: string, isRefresh = false): Promise<AuthTokens> {
    const {
      clientId,
      clientSecret,
      contentType,
      provider,
      tokenEndpoint,
      redirectUri,
      autoRefresh = true
    } = this.props
    const grantType = 'authorization_code'

    let payload: TokenRequestBody = {
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      redirectUri,
      grantType
    }
    if (isRefresh) {
      payload = {
        ...payload,
        grantType: 'refresh_token',
        refresh_token: code
      }
    } else {
      const pkce: PKCECodePair = this.getPkce()
      const codeVerifier = pkce.codeVerifier
      payload = {
        ...payload,
        code,
        codeVerifier
      }
    }

    const response = await fetch(`${tokenEndpoint || `${provider}/token`}`, {
      headers: {
        'Content-Type': contentType || 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      body: toUrlEncoded({ ...payload })
    })

    this.removeItem('pkce')
    const json = await response.json()
    if (isRefresh && !json.refresh_token) {
      json.refresh_token = payload.refresh_token
    }
    this.setAuthTokens(json as AuthTokens)
    if (autoRefresh) {
      this.startTimer()
    }

    return this.getAuthTokens()
  }

  armRefreshTimer(refreshToken: string, timeoutDuration: number): void {
    if (this.timeout) {
      clearTimeout(this.timeout)
    }
    this.timeout = window.setTimeout(() => {
      this.fetchToken(refreshToken, true)
        .then(({ refresh_token: newRefreshToken, expires_at: expiresAt }) => {
          if (!expiresAt) return
          const now = new Date().getTime()
          const timeout = expiresAt - now
          if (timeout > 0) {
            this.armRefreshTimer(newRefreshToken, timeout)
          } else {
            this.removeItem('auth')
            this.removeCodeFromLocation()
          }
        })
        .catch((e) => {
          this.removeItem('auth')
          this.removeCodeFromLocation()
          console.warn({ e })
        })
    }, timeoutDuration)
  }

  startTimer(): void {
    if (!this.isAuthenticated()) {
      return
    }
    const authTokens = this.getAuthTokens()
    const { refresh_token: refreshToken, expires_at: expiresAt } = authTokens
    if (!expiresAt || !refreshToken) {
      return
    }
    const now = new Date().getTime()
    const timeout = expiresAt - now
    if (timeout > 0) {
      this.armRefreshTimer(refreshToken, timeout)
    } else {
      this.removeItem('auth')
      this.removeCodeFromLocation()
    }
  }

  restoreUri(): void {
    const uri = this.getItem('preAuthUri')
    this.removeItem('preAuthUri')
    console.log({ uri })
    if (uri !== null) {
      window.location.replace(uri)
    }
    this.removeCodeFromLocation()
  }

  private getItem(key: string): string | null {
    const { localStoragePrefix = '' } = this.props
    return window.localStorage.getItem(localStoragePrefix + key)
  }

  private haveItem(key: string): boolean {
    return this.getItem(key) !== null
  }

  private removeItem(key: string): void {
    const { localStoragePrefix = '' } = this.props
    window.localStorage.removeItem(localStoragePrefix + key)
  }

  private setItem(key: string, value: string): void {
    const { localStoragePrefix = '' } = this.props
    window.localStorage.setItem(localStoragePrefix + key, value)
  }
}
