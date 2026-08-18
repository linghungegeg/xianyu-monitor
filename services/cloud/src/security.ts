import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'

export type SubjectKind = 'user' | 'admin' | 'collector'

export type TokenDomain = {
  issuer: string
  audience: string
  secret: string
}

export type AccessClaims = JWTPayload & {
  subjectKind: SubjectKind
  sessionId: string
  clientId?: string
}

function providerSecret(secret: string): Buffer { return createHash('sha256').update(`${secret}:provider-config`).digest() }

export function encryptProviderKey(value: string, secret: string): string {
  const iv = Buffer.from(randomUUID().replaceAll('-', ''), 'hex').subarray(0, 12)
  const cipher = createCipheriv('aes-256-gcm', providerSecret(secret), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}

export function decryptProviderKey(value: string | null, secret: string): string | null {
  if (!value) return null
  try {
    const bytes = Buffer.from(value, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', providerSecret(secret), bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  } catch { return null }
}

const textEncoder = new TextEncoder()
const scryptCost = 16_384
const scryptBlockSize = 8
const scryptParallelism = 1
const passwordKeyLength = 32

function secretKey(secret: string): Uint8Array {
  if (Buffer.byteLength(secret) < 32) throw new Error('令牌密钥至少需要 32 字节')
  return textEncoder.encode(secret)
}

function encode(value: Buffer): string {
  return value.toString('base64url')
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 6 || password.length > 20) throw new Error('密码需要 6 到 20 个字符')
  const salt = randomBytes(16)
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, passwordKeyLength, { N: scryptCost, r: scryptBlockSize, p: scryptParallelism }, (error, key) => error ? reject(error) : resolve(Buffer.from(key)))
  })
  return `scrypt$v=1$N=${scryptCost},r=${scryptBlockSize},p=${scryptParallelism}$${encode(salt)}$${encode(derived)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, version, parameters, saltValue, hashValue] = stored.split('$')
  if (algorithm !== 'scrypt' || version !== 'v=1' || !parameters || !saltValue || !hashValue) return false
  const matches = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parameters)
  if (!matches) return false
  if (Number(matches[1]) !== scryptCost || Number(matches[2]) !== scryptBlockSize || Number(matches[3]) !== scryptParallelism) return false
  const expected = decode(hashValue)
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, decode(saltValue), expected.length, { N: Number(matches[1]), r: Number(matches[2]), p: Number(matches[3]) }, (error, key) => error ? reject(error) : resolve(Buffer.from(key)))
  })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

export function createRefreshToken(): { token: string; hash: string } {
  const token = encode(randomBytes(32))
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

export async function signAccessToken(domain: TokenDomain, subjectKind: SubjectKind, subjectId: string, sessionId: string, clientId?: string): Promise<string> {
  return new SignJWT({ subjectKind, sessionId, ...(clientId ? { clientId } : {}) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(domain.issuer)
    .setAudience(domain.audience)
    .setSubject(subjectId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secretKey(domain.secret))
}

export async function verifyAccessToken(domain: TokenDomain, expectedKind: SubjectKind, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secretKey(domain.secret), { issuer: domain.issuer, audience: domain.audience })
  if (payload.subjectKind !== expectedKind || !payload.sub || typeof payload.sessionId !== 'string') throw new Error('令牌主体不匹配')
  return payload as AccessClaims
}
