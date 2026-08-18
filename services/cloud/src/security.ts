import { argon2, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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

const textEncoder = new TextEncoder()
const argon2Memory = 65_536
const argon2Passes = 3
const argon2Parallelism = 1
const argon2TagLength = 32

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
    argon2('argon2id', { message: password, nonce: salt, memory: argon2Memory, passes: argon2Passes, parallelism: argon2Parallelism, tagLength: argon2TagLength }, (error, key) => error ? reject(error) : resolve(Buffer.from(key)))
  })
  return `argon2id$v=1$m=${argon2Memory},t=${argon2Passes},p=${argon2Parallelism}$${encode(salt)}$${encode(derived)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, version, parameters, saltValue, hashValue] = stored.split('$')
  if (algorithm !== 'argon2id' || version !== 'v=1' || !parameters || !saltValue || !hashValue) return false
  const matches = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parameters)
  if (!matches) return false
  const expected = decode(hashValue)
  const derived = await new Promise<Buffer>((resolve, reject) => {
    argon2('argon2id', { message: password, nonce: decode(saltValue), memory: Number(matches[1]), passes: Number(matches[2]), parallelism: Number(matches[3]), tagLength: expected.length }, (error, key) => error ? reject(error) : resolve(Buffer.from(key)))
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
