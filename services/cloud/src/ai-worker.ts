import { createHash, randomUUID } from 'node:crypto'
import { decryptProviderKey } from './security.ts'

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }
type Sql = Queryable & { transaction?: <T>(callback: (sql: Queryable) => Promise<T>) => Promise<T> }
type ProviderInput = {
  jobId: string
  idempotencyKey: string
  capabilityCode: string
  providerModelReference: string
  providerSettings: unknown
  providerBaseUrl?: string
  providerApiKeyCiphertext?: string | null
  promptBody: string
  input: unknown
  inputHash: string
}
type ProviderResult = { insightType: string; entityReference?: string | null; result: unknown; confidence?: number | null }
type Provider = { complete: (input: ProviderInput) => Promise<ProviderResult> }

const LEASE_SECONDS = 15 * 60
const RETRY_DELAY_SECONDS = 0
const MAX_RETRIES = 5
const PROVIDER_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 1_000

async function inTransaction<T>(sql: Sql, callback: (transaction: Queryable) => Promise<T>): Promise<T> {
  if (sql.transaction) return sql.transaction(callback)
  await sql.query('BEGIN')
  try {
    const result = await callback(sql)
    await sql.query('COMMIT')
    return result
  } catch (error) {
    await sql.query('ROLLBACK')
    throw error
  }
}

async function scopedMarketItems(sql: Queryable, scope: string, userId: string) {
  const personal = scope === 'personal'
  const result = await sql.query(`SELECT i.id AS "itemId",i.platform,i.platform_item_id AS "platformItemId",i.lifecycle_state AS state,i.last_seen_at AS "lastSeenAt",
      v.title,v.price,v.region,v.condition_text AS "conditionText",v.want_count AS "wantCount"
    FROM market.items i
    LEFT JOIN LATERAL (
      SELECT title,price,region,condition_text,want_count
      FROM market.item_versions
      WHERE item_id=i.id
      ORDER BY observed_at DESC,id DESC
      LIMIT 1
    ) v ON TRUE
    WHERE ($1 <> 'personal' OR EXISTS (
      SELECT 1
      FROM market.observations o
      JOIN ops.collection_runs r ON r.id=o.collection_run_id
      JOIN identity.collector_clients c ON c.id=r.client_id
      WHERE o.item_id=i.id AND c.user_id=$2
    ))
    ORDER BY i.last_seen_at DESC,i.id DESC
    LIMIT 200`, [personal ? 'personal' : 'global', userId])
  return result.rows
}

async function claimJob(sql: Sql, workerId: string): Promise<any | undefined> {
  const claim = async (transaction: Queryable) => {
    const selected = await transaction.query(`WITH candidate AS (
        SELECT j.id,j.created_at
        FROM ai.jobs j
        WHERE (
          j.status='queued'
          OR (j.status='failed' AND j.retry_count < $2 AND (j.finished_at IS NULL OR j.finished_at <= now() - ($3 * interval '1 second')))
          OR (j.status='running' AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= now()))
        )
        ORDER BY j.created_at ASC,j.id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE ai.jobs j
        SET status='running',started_at=COALESCE(j.started_at,now()),lease_owner=$1,lease_expires_at=now()+($4 * interval '1 second')
        FROM candidate c
        WHERE j.id=c.id AND j.created_at=c.created_at
        RETURNING j.*
      )
      SELECT j.id,j.created_at,j.requesting_user_id,j.idempotency_key,j.input_payload,j.scope,
        c.code AS capability_code,p.prompt_body,
        cfg.model_reference AS provider_model_reference,cfg.base_url AS provider_base_url,
        cfg.api_key_ciphertext AS provider_api_key_ciphertext,cfg.settings AS provider_settings
      FROM claimed j
      JOIN ai.capabilities c ON c.id=j.capability_id
      JOIN ai.prompt_versions p ON p.id=j.prompt_version_id
      LEFT JOIN ai.provider_configs cfg ON cfg.provider_code=p.provider_reference AND cfg.status='active'`, [workerId, MAX_RETRIES, RETRY_DELAY_SECONDS, LEASE_SECONDS])
    return selected.rows[0]
  }
  return sql.transaction ? sql.transaction(claim) : claim(sql)
}

function providerEndpoint(baseUrl: string): string {
  const normalized = new URL(baseUrl)
  if (!['http:', 'https:'].includes(normalized.protocol)) throw new Error('AI 提供方地址无效')
  const value = normalized.toString().replace(/\/$/, '')
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`
}

function providerContent(payload: any): unknown {
  const content = payload?.choices?.[0]?.message?.content
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === 'string' ? part.text : '').join('')
  return content
}

function normalizeProviderResult(content: unknown, capabilityCode: string): ProviderResult {
  let parsed: unknown = content
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content) } catch { parsed = { text: content } }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const object = parsed as Record<string, unknown>
    const confidence = typeof object.confidence === 'number' && Number.isFinite(object.confidence) ? object.confidence : null
    return {
      insightType: typeof object.insightType === 'string' && object.insightType.trim() ? object.insightType.trim().slice(0, 128) : capabilityCode,
      entityReference: typeof object.entityReference === 'string' ? object.entityReference.slice(0, 256) : null,
      result: object.result ?? object,
      confidence
    }
  }
  return { insightType: capabilityCode, result: { value: parsed ?? null } }
}

export function createConfiguredAiProvider(adminSecret: string): Provider {
  return {
    async complete(input) {
      if (!input.providerBaseUrl) throw new Error('AI 提供方未启用')
      const endpoint = providerEndpoint(input.providerBaseUrl)
      const apiKey = decryptProviderKey(input.providerApiKeyCiphertext ?? null, adminSecret)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
      try {
        const settings = input.providerSettings && typeof input.providerSettings === 'object' && !Array.isArray(input.providerSettings)
          ? input.providerSettings as Record<string, unknown>
          : {}
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ ...settings, model: input.providerModelReference, messages: [{ role: 'system', content: input.promptBody }, { role: 'user', content: JSON.stringify(input.input) }] }),
          redirect: 'error',
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`AI 提供方请求失败 (${response.status})`)
        return normalizeProviderResult(providerContent(await response.json()), input.capabilityCode)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw new Error('AI 提供方请求超时')
        throw error
      } finally {
        clearTimeout(timeout)
      }
    }
  }
}

export function createAiWorker(sql: Sql, options: { provider: Provider; workerId: string }) {
  return {
    async runOnce(): Promise<boolean> {
      const job = await claimJob(sql, options.workerId)
      if (!job) return false
      try {
        const originalInput = job.input_payload && typeof job.input_payload === 'object' && !Array.isArray(job.input_payload) ? job.input_payload : {}
        const input = { ...originalInput, scope: String(job.scope), marketItems: await scopedMarketItems(sql, String(job.scope), String(job.requesting_user_id)) }
        const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
        const result = await options.provider.complete({
          jobId: String(job.id),
          idempotencyKey: `ai:${job.id}`,
          capabilityCode: String(job.capability_code),
          providerModelReference: String(job.provider_model_reference),
          providerSettings: job.provider_settings ?? {},
          providerBaseUrl: job.provider_base_url ? String(job.provider_base_url) : undefined,
          providerApiKeyCiphertext: job.provider_api_key_ciphertext ? String(job.provider_api_key_ciphertext) : null,
          promptBody: String(job.prompt_body),
          input,
          inputHash
        })
        await inTransaction(sql, async (transaction) => {
          await transaction.query(`INSERT INTO ai.insights (id,ai_job_id,insight_type,entity_reference,result,confidence,created_at)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT (ai_job_id,insight_type) DO NOTHING`, [randomUUID(), job.id, result.insightType, result.entityReference ?? null, JSON.stringify(result.result ?? {}), result.confidence ?? null])
          const ledgerId = randomUUID()
          const dedup = await transaction.query(`INSERT INTO billing.usage_ledger_dedup (subject_type,subject_id,idempotency_key,ledger_id,occurred_at)
            VALUES ('user',$1,$2,$3,now()) ON CONFLICT (subject_type,subject_id,idempotency_key) DO NOTHING RETURNING ledger_id,occurred_at`, [job.requesting_user_id, `ai:${job.id}`, ledgerId])
          if (dedup.rows[0]) {
            await transaction.query(`INSERT INTO billing.usage_ledger (id,occurred_at,user_id,meter,quantity,unit_price,idempotency_key,source_reference)
              VALUES ($1,$2,$3,'ai_job',1,0,$4,$5)`, [ledgerId, dedup.rows[0].occurred_at, job.requesting_user_id, `ai:${job.id}`, job.id])
          }
          await transaction.query(`UPDATE ai.jobs SET status='completed',finished_at=now(),cost_quantity=1,billing_reference=$3,last_error=NULL,lease_owner=NULL,lease_expires_at=NULL
            WHERE id=$1 AND created_at=$2 AND status='running' AND lease_owner=$4`, [job.id, job.created_at, `ai:${job.id}`, options.workerId])
        })
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 256) : 'AI provider failed'
        await sql.query(`UPDATE ai.jobs SET status='failed',finished_at=now(),retry_count=retry_count+1,last_error=$3,lease_owner=NULL,lease_expires_at=NULL
          WHERE id=$1 AND created_at=$2 AND status='running' AND lease_owner=$4`, [job.id, job.created_at, message, options.workerId])
        return false
      }
    }
  }
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

export async function runAiWorker(worker: { runOnce: () => Promise<boolean> }, options: { signal: AbortSignal; pollMs?: number }): Promise<void> {
  while (!options.signal.aborted) {
    try {
      const worked = await worker.runOnce()
      if (!worked) await waitFor(options.pollMs ?? DEFAULT_POLL_MS, options.signal)
    } catch (error) {
      console.error('AI worker loop error', error)
      await waitFor(options.pollMs ?? DEFAULT_POLL_MS, options.signal)
    }
  }
}
