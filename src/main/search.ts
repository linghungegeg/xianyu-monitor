export type SearchSort = 'comprehensive' | 'newly_reduced' | 'newly_published' | 'price_asc' | 'price_desc'
export type SellerItemState = 'active' | 'sold' | 'offline' | 'unknown'

export type SearchRule = {
  keyword?: string
  categoryPath?: string[]
  sort: SearchSort
  minPrice?: number
  maxPrice?: number
  region?: string
  filters?: Record<string, string>
  includeWords?: string[]
  excludeWords?: string[]
  pageLimit: number
}

export type SearchCardSource = {
  href: string
  text: string
  title?: string | null
  imageUrls?: string[]
  tags?: string[]
}

export type SearchCandidate = {
  platformItemId: string
  url: string
  title: string
  price: number | null
  region: string | null
  publishedText: string | null
  wantCount: number | null
  imageUrls: string[]
  tags: string[]
}

export type SearchDetailSource = {
  title?: string | null
  priceText?: string | null
  region?: string | null
  publishedText?: string | null
  wantText?: string | null
  description?: string | null
  conditionText?: string | null
  imageUrls?: string[]
  tags?: string[]
}

export type CollectedItem = SearchCandidate & {
  description: string | null
  conditionText: string | null
}

export type SellerProfileSource = {
  profileUrl: string
  platformSellerId?: string | null
  publicName?: string | null
  region?: string | null
  publicProfile?: Record<string, string | number | boolean | null>
}

export type SellerProfile = {
  platform: 'goofish'
  platformSellerId: string
  profileUrl: string
  publicName: string | null
  region: string | null
  publicProfile: Record<string, string | number | boolean | null>
}

export class SearchPageError extends Error {
  readonly kind: 'login' | 'access' | 'structure' | 'network'

  constructor(kind: 'login' | 'access' | 'structure' | 'network', message: string) {
    super(message)
    this.kind = kind
  }
}

const REGION_PATTERN = /(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/

function compact(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function uniqueStrings(values: readonly string[] | undefined): string[] {
  if (!values) return []
  const unique = new Set<string>()
  for (const value of values) {
    const normalized = compact(value)
    if (normalized) unique.add(normalized)
  }
  return [...unique]
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => compact(value)).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

function parsePrice(value: string | null | undefined): number | null {
  const match = compact(value).match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/)
  if (!match) return null
  const price = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(price) ? price : null
}

function parseWantCount(value: string | null | undefined): number | null {
  const match = compact(value).match(/(\d+)\s*人?想要/)
  return match ? Number(match[1]) : null
}

function parsePublishedText(value: string | null | undefined): string | null {
  const match = compact(value).match(/(刚刚(?:发布)?|\d+(?:分钟|小时|天|月)前(?:发布|降价)?|累计降价\s*[^\s]+)/)
  return match?.[1] ?? null
}

function parseRegion(value: string | null | undefined): string | null {
  return compact(value).match(REGION_PATTERN)?.[1] ?? null
}

function itemIdFromHref(href: string): { id: string; url: string } | null {
  try {
    const url = new URL(href, 'https://www.goofish.com/')
    const id = url.searchParams.get('id') ?? url.searchParams.get('itemId') ?? url.searchParams.get('item_id') ?? /\/item\/([^/?#]+)/.exec(url.pathname)?.[1]
    if (!id || id.length > 128) return null
    return { id, url: url.toString() }
  } catch {
    return null
  }
}

function sellerIdFromUrl(value: string): { id: string; url: string } | null {
  try {
    const url = new URL(value, 'https://www.goofish.com/')
    const id = url.searchParams.get('sellerId')
      ?? url.searchParams.get('seller_id')
      ?? url.searchParams.get('userId')
      ?? url.searchParams.get('user_id')
      ?? /\/(?:seller|user)\/([^/?#]+)/.exec(url.pathname)?.[1]
    if (!id || id.length > 128) return null
    return { id, url: url.toString() }
  } catch {
    return null
  }
}

function titleFromText(value: string, price: number | null): string {
  const text = compact(value)
  const beforePrice = text.split(/[¥￥]\s*[\d,]/)[0]
  const title = compact(beforePrice || text).slice(0, 300)
  if (!title || (price !== null && title === String(price))) return ''
  return title
}

export function parseSearchCards(sources: readonly SearchCardSource[]): SearchCandidate[] {
  const found = new Map<string, SearchCandidate>()
  for (const source of sources) {
    const item = itemIdFromHref(source.href)
    if (!item) continue
    const text = compact(source.text)
    const price = parsePrice(text)
    const title = compact(source.title) || titleFromText(text, price)
    if (!title) continue
    found.set(item.id, {
      platformItemId: item.id,
      url: item.url,
      title,
      price,
      region: parseRegion(text),
      publishedText: parsePublishedText(text),
      wantCount: parseWantCount(text),
      imageUrls: uniqueStrings(source.imageUrls),
      tags: uniqueStrings(source.tags)
    })
  }
  return [...found.values()]
}

export function mergeSearchDetail(candidate: SearchCandidate, source: SearchDetailSource): CollectedItem {
  const detailText = compact(`${source.title ?? ''} ${source.priceText ?? ''} ${source.region ?? ''} ${source.publishedText ?? ''} ${source.wantText ?? ''}`)
  const title = compact(source.title) || candidate.title
  return {
    ...candidate,
    title,
    price: parsePrice(source.priceText) ?? candidate.price,
    region: parseRegion(source.region) ?? parseRegion(detailText) ?? candidate.region,
    publishedText: parsePublishedText(source.publishedText) ?? parsePublishedText(detailText) ?? candidate.publishedText,
    wantCount: parseWantCount(source.wantText) ?? parseWantCount(detailText) ?? candidate.wantCount,
    imageUrls: uniqueStrings(source.imageUrls).length ? uniqueStrings(source.imageUrls) : candidate.imageUrls,
    tags: uniqueStrings(source.tags).length ? uniqueStrings(source.tags) : candidate.tags,
    description: compact(source.description).slice(0, 5_000) || null,
    conditionText: compact(source.conditionText).slice(0, 160) || null
  }
}

export function parseSellerProfile(source: SellerProfileSource): SellerProfile | null {
  const fromUrl = sellerIdFromUrl(source.profileUrl)
  const platformSellerId = compact(source.platformSellerId) || fromUrl?.id || ''
  if (!platformSellerId || platformSellerId.length > 128) return null
  const profileUrl = fromUrl?.url ?? source.profileUrl
  try {
    const url = new URL(profileUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return null
  } catch {
    return null
  }
  const publicProfile: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(source.publicProfile ?? {})) {
    const normalizedKey = compact(key).slice(0, 80)
    if (!normalizedKey || value === undefined) continue
    if (typeof value === 'string') publicProfile[normalizedKey] = compact(value).slice(0, 500)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) publicProfile[normalizedKey] = value
  }
  return {
    platform: 'goofish',
    platformSellerId,
    profileUrl,
    publicName: compact(source.publicName).slice(0, 160) || null,
    region: parseRegion(source.region),
    publicProfile
  }
}

export function matchesSearchRule(item: CollectedItem, rule: SearchRule): boolean {
  if (rule.minPrice !== undefined && (item.price === null || item.price < rule.minPrice)) return false
  if (rule.maxPrice !== undefined && (item.price === null || item.price > rule.maxPrice)) return false
  if (rule.region && item.region !== rule.region) return false
  const searchable = `${item.title} ${item.description ?? ''} ${item.tags.join(' ')}`.toLocaleLowerCase('zh-CN')
  if (rule.includeWords?.some((word) => !searchable.includes(word.toLocaleLowerCase('zh-CN')))) return false
  if (rule.excludeWords?.some((word) => searchable.includes(word.toLocaleLowerCase('zh-CN')))) return false
  return true
}

export function canonicalItemPayload(item: CollectedItem): string {
  return JSON.stringify({
    platform: 'goofish',
    platformItemId: item.platformItemId,
    title: item.title,
    price: item.price,
    region: item.region,
    publishedText: item.publishedText,
    wantCount: item.wantCount,
    imageUrls: [...item.imageUrls],
    tags: [...item.tags],
    description: item.description
  })
}

export function canonicalSellerItemPayload(item: CollectedItem): string {
  return JSON.stringify({
    platform: 'goofish',
    platformItemId: item.platformItemId,
    title: item.title,
    price: item.price,
    region: item.region,
    wantCount: item.wantCount,
    imageUrls: canonicalStrings(item.imageUrls),
    tags: canonicalStrings(item.tags),
    description: item.description,
    conditionText: item.conditionText
  })
}

export function canonicalSellerProfilePayload(profile: SellerProfile): string {
  return JSON.stringify({
    platform: profile.platform,
    platformSellerId: profile.platformSellerId,
    publicName: profile.publicName,
    region: profile.region,
    publicProfile: Object.fromEntries(Object.entries(profile.publicProfile).sort(([left], [right]) => left.localeCompare(right, 'zh-CN')))
  })
}
