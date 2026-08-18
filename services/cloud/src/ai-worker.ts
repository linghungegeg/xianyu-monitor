import { createHash, randomUUID } from 'node:crypto'

type Sql = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }
type Provider = { complete: (input: { jobId: string; idempotencyKey: string; capabilityCode: string; providerModelReference: string; providerSettings: unknown; promptBody: string; input: unknown; inputHash: string }) => Promise<{ insightType: string; entityReference?: string | null; result: unknown; confidence?: number | null }> }

async function scopedMarketItems(sql: Sql, scope: string, userId: string) {
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

export function createAiWorker(sql: Sql, options: { provider: Provider; workerId: string }) {
  return {
    async runOnce(): Promise<boolean> {
      const selected = await sql.query(`SELECT j.id, j.requesting_user_id, j.idempotency_key, j.input_payload, j.scope,
          c.code AS capability_code, p.prompt_body, cfg.model_reference AS provider_model_reference, cfg.settings AS provider_settings
        FROM ai.jobs j
        JOIN ai.capabilities c ON c.id = j.capability_id
        JOIN ai.prompt_versions p ON p.id = j.prompt_version_id
        LEFT JOIN ai.provider_configs cfg ON cfg.provider_code = p.provider_reference AND cfg.status = 'active'
        WHERE j.status IN ('queued', 'failed')
        ORDER BY j.created_at ASC, j.id ASC LIMIT 1`)
      const job = selected.rows[0]
      if (!job) return false
      const claimed = await sql.query(`UPDATE ai.jobs SET status='running', started_at=COALESCE(started_at, now())
        WHERE id=$1 AND status IN ('queued', 'failed') RETURNING id`, [job.id])
      if (!claimed.rows[0]) return false
      try {
        if (!job.provider_model_reference) throw new Error('AI 提供方未启用')
        const originalInput = job.input_payload && typeof job.input_payload === 'object' && !Array.isArray(job.input_payload) ? job.input_payload : {}
        const input = { ...originalInput, scope: String(job.scope), marketItems: await scopedMarketItems(sql, String(job.scope), String(job.requesting_user_id)) }
        const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
        const result = await options.provider.complete({ jobId: String(job.id), idempotencyKey: `ai:${job.id}`, capabilityCode: String(job.capability_code), providerModelReference: String(job.provider_model_reference), providerSettings: job.provider_settings ?? {}, promptBody: String(job.prompt_body), input, inputHash })
        await sql.query('BEGIN')
        try {
        await sql.query(`INSERT INTO ai.insights (id,ai_job_id,insight_type,entity_reference,result,confidence,created_at)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,now()) ON CONFLICT (ai_job_id,insight_type) DO NOTHING`, [randomUUID(), job.id, result.insightType, result.entityReference ?? null, JSON.stringify(result.result ?? {}), result.confidence ?? null])
        const ledgerId = randomUUID()
        const dedup = await sql.query(`INSERT INTO billing.usage_ledger_dedup (subject_type,subject_id,idempotency_key,ledger_id,occurred_at)
          VALUES ('user',$1,$2,$3,now()) ON CONFLICT (subject_type,subject_id,idempotency_key) DO NOTHING RETURNING ledger_id,occurred_at`, [job.requesting_user_id, `ai:${job.id}`, ledgerId])
        if (dedup.rows[0]) {
          await sql.query(`INSERT INTO billing.usage_ledger (id,occurred_at,user_id,meter,quantity,unit_price,idempotency_key,source_reference)
            VALUES ($1,$2,$3,'ai_job',1,0,$4,$5)`, [ledgerId, dedup.rows[0].occurred_at, job.requesting_user_id, `ai:${job.id}`, job.id])
        }
        await sql.query(`UPDATE ai.jobs SET status='completed', finished_at=now(), cost_quantity=1, billing_reference=$2, last_error=NULL WHERE id=$1`, [job.id, `ai:${job.id}`])
        await sql.query('COMMIT')
        return true
        } catch (error) {
          await sql.query('ROLLBACK')
          throw error
        }
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 256) : 'AI provider failed'
        await sql.query(`UPDATE ai.jobs SET status='failed', finished_at=now(), retry_count=retry_count+1, last_error=$2 WHERE id=$1`, [job.id, message])
        return false
      }
    }
  }
}
