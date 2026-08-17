# 阶段 0：数据、分页与容量合同

## 0. 审计结论与边界

本合同定义阶段 0 已冻结的云端数据边界，不代表现有 Electron 原型已经具备这些能力。

当前原型仅有采集启动器本地 SQLite：`tasks`、`items`、`scan_logs`。其中商品仅以 `(task_id, item_id)` 去重，列表以固定 `LIMIT` 返回；没有云端数据实体、事件版本链、服务端分页、对象存储、用户/Admin 认证或容量配置。因此，以下合同必须在阶段 0 冻结，并在阶段 1 建库前落实为可重复执行的迁移与测试数据生成器。

三个产品和 API 域保持独立。以下仅是域名占位，不能视为部署地址：

| 产品或接口 | 占位域名 | 职责 |
| --- | --- | --- |
| User Web | `user.placeholder.invalid` | 用户工作台与未来 APK 共用的用户业务入口 |
| Admin Web | `admin.placeholder.invalid` | 运营与系统管理入口 |
| User API | `user-api.placeholder.invalid` | 用户 Web / APK 的业务与权益 API |
| Collector API | `collector-api.placeholder.invalid` | 启动器设备绑定、任务领取、数据上报 |
| Admin API | `admin-api.placeholder.invalid` | Admin 专属管理 API |

云端不保存或接收闲鱼 Cookie、Token、扫码登录态、浏览器 Profile、闲鱼账号操作状态。本合同只覆盖本系统账号、设备和允许共享的公开市场数据。

## 1. 通用数据规则

- 主键：自有实体使用 UUIDv7；闲鱼商品/卖家稳定 ID 使用 `text` 业务键，禁止把页面 URL、标题或昵称作为唯一键。
- 时间：所有服务端时间字段使用 `timestamptz` 和 UTC；客户端上报同时带 `collected_at`（采集观测时间）与 `received_at`（云端接收时间）。
- 金额：使用 `numeric(14,2)`，不使用浮点数；币种字段固定为 ISO 4217 `CNY`，为未来扩展保留字段。
- 枚举：状态、事件类型、日志级别以受控字符串或 PostgreSQL enum 约束，不能让前端任意写入。
- 公开详情的结构化字段进入列或 `jsonb`；图片、原始页面快照等大对象仅存对象存储，数据库只保存不可变对象键、SHA-256、MIME、大小和采集时间。
- 写入必须携带 `request_id`、`client_id`（采集器 API）或 `actor_id`（用户/Admin API），可审计且可幂等。密钥、密码、Cookie、Authorization 头、完整 Token 不能进入任意日志或原始载荷。
- PostgreSQL 是事实源；Redis 只用于缓存、分布式锁、限流和短期游标/PIT 状态；搜索索引是可从事实源重建的派生读模型；消息队列承载异步传递，不保存唯一事实。

## 2. 身份、设备、计费实体

| 实体 | 主键与业务唯一键 | 关键字段 | 索引 / 约束 |
| --- | --- | --- | --- |
| `users` | `id uuid`；`email_normalized` 唯一 | email、password_hash、status、created_at、disabled_at | `UNIQUE(email_normalized)`；`status, created_at desc, id desc` |
| `admin_users` | `id uuid`；`email_normalized` 唯一 | email、password_hash、role、status、mfa_state | 独立表、独立 issuer、独立数据库角色；不得复用 `users` 会话 |
| `collector_clients` | `id uuid`；`(user_id, device_public_key_fingerprint)` 唯一 | user_id、device_name、platform、app_version、status、last_seen_at、revoked_at | `user_id, status, last_seen_at desc`；指纹只保存哈希 |
| `auth_refresh_sessions` | `id uuid`；refresh token family 唯一 | subject_type、subject_id、token_hash、expires_at、revoked_at | `subject_type, subject_id, expires_at desc`；只保存 Token 哈希 |
| `plans` | `id uuid`；`code` 唯一 | code、name、entitlement_policy_version、active | `UNIQUE(code)` |
| `subscriptions` | `id uuid`；外部订阅引用唯一 | user_id、plan_id、status、period_start/end | `(user_id, status, period_end desc)` |
| `orders` | `id uuid`；`provider + provider_order_id` 唯一 | user_id、amount、currency、status、paid_at | `UNIQUE(provider, provider_order_id)`；`user_id, created_at desc, id desc` |
| `usage_ledger` | `id uuid`；`(subject_type, subject_id, idempotency_key)` 唯一 | user_id、client_id、meter、quantity、unit_price、occurred_at、source_ref | 见第 5 节按月分区；`user_id, occurred_at desc, id desc` |
| `entitlement_grants` | `id uuid`；`(user_id, capability, effective_from)` 唯一 | capability、limit、effective_from/to、source | `user_id, capability, effective_to desc` |

计费账本只允许追加冲正，禁止修改历史行或以余额字段覆盖历史。采集启动器只接收短期、按设备签发的权限快照；套餐、余额、权益和扣费均由云端账本决定。

## 3. 市场、采集、版本与事件实体

| 实体 | 主键与去重键 | 关键字段 | 索引 / 约束 |
| --- | --- | --- | --- |
| `category_taxonomy` | `id uuid`；`(platform, platform_category_id)` 唯一 | parent_id、name、path、depth、active、observed_at | `parent_id, name`；`platform, path` |
| `seller_profiles` | `id uuid`；`(platform, platform_seller_id)` 唯一 | public_name、region、public_profile、first_seen_at、last_seen_at、current_version_id | `platform, platform_seller_id`；`region, id` |
| `seller_profile_versions` | `id uuid`；`(seller_id, content_hash)` 唯一 | seller_id、canonical_payload、content_hash、observed_at、source_object_id | `seller_id, observed_at desc, id desc` |
| `market_items` | `id uuid`；`(platform, platform_item_id)` 唯一 | seller_id、category_id、current_version_id、first_seen_at、last_seen_at、lifecycle_state | `seller_id, last_seen_at desc, id desc`；`category_id, last_seen_at desc, id desc`；`lifecycle_state, last_seen_at desc, id desc` |
| `market_item_versions` | `id uuid`；`(item_id, content_hash)` 唯一 | typed title/price/region/condition/publish time/want count、canonical_payload、content_hash、observed_at、source_object_id | `item_id, observed_at desc, id desc`；`price, observed_at desc, id desc`；必要的全文/筛选字段同步至搜索读模型 |
| `seller_item_relations` | `id uuid`；`(seller_id, item_id)` 唯一 | first_seen_at、last_seen_at、state、current | `seller_id, state, last_seen_at desc, item_id` |
| `collection_runs` | `id uuid`；`(client_id, client_run_id)` 唯一 | client_id、task_ref、kind、started_at、finished_at、status、result counts | `client_id, started_at desc, id desc`；`status, started_at desc` |
| `market_observations` | `id uuid`；`(collection_run_id, platform_item_id)` 唯一 | collection_run_id、item_id nullable、platform item/seller ID、observed payload hash、collected_at、received_at | 第 5 节按月分区；`platform_item_id, collected_at desc, id desc`；`collection_run_id, id` |
| `market_item_events` | `id uuid`；`event_key` 唯一 | item_id、seller_id、event_type、before_version_id、after_version_id、occurred_at、detected_at、event_key | 第 5 节按月分区；`item_id, occurred_at desc, id desc`；`seller_id, occurred_at desc, id desc`；`event_type, occurred_at desc, id desc` |
| `media_objects` | `id uuid`；`sha256` 唯一 | object_key、mime_type、byte_size、sha256、visibility、created_at | `UNIQUE(sha256)`；对象键不可变，禁止把二进制写入 PostgreSQL |
| `item_media_relations` | `(item_version_id, media_object_id)` 复合主键 | position、role、created_at | `item_version_id, position` |
| `ingest_batches` | `id uuid`；`(client_id, idempotency_key)` 唯一 | client_id、batch sequence、payload hash、status、accepted/rejected counts、received_at | `client_id, received_at desc, id desc`；相同幂等键必须返回同一处理结果 |
| `ingest_rejections` | `id uuid`；`(ingest_batch_id, record_index)` 唯一 | reason_code、safe_detail、created_at | `ingest_batch_id, record_index` |
| `dynamic_logs` | `id uuid` | actor scope、client_id、task_ref、object refs、level、event_type、safe_message、occurred_at | 第 5 节按月分区；按用户/任务/卖家/商品/level 的组合索引 |

### 3.1 去重与版本判定

1. **规范实体去重**：商品仅由 `(platform, platform_item_id)` 唯一；卖家仅由 `(platform, platform_seller_id)` 唯一；类目仅由 `(platform, platform_category_id)` 唯一。
2. **上传幂等**：每批上传用 `(client_id, idempotency_key)`；每次采集运行用 `(client_id, client_run_id)`；重复请求不得创建第二批、第二次扣费或第二份事件。
3. **版本去重**：对允许共享的规范化公开字段按固定字段顺序序列化后计算 `SHA-256 content_hash`。`(item_id, content_hash)` 和 `(seller_id, content_hash)` 唯一；相同内容只刷新 `last_seen_at`，不新增版本。
4. **事件去重**：`event_key = SHA-256(platform + entity business key + event_type + before_version hash + after_version hash)`。事件写入与版本落库处于同一事务或同一可恢复 outbox 流程。
5. **媒体去重**：以内容 `sha256` 去重；下载来源 URL 不是媒体唯一键。
6. **冲突原则**：`collected_at` 晚的观测优先；同一采集时间用 `received_at` 再以不可变记录 ID 排序。任何冲突保留原始观测引用供 Admin 审计，不覆盖历史版本。

## 4. 任务、AI、运营与审计实体

| 实体 | 主键与业务唯一键 | 关键字段 | 索引 / 约束 |
| --- | --- | --- | --- |
| `monitor_tasks` | `id uuid` | user_id、kind、rule_json、status、interval_seconds、next_run_at | `user_id, status, next_run_at, id`；规则版本化 |
| `seller_monitor_tasks` | `id uuid`；`(user_id, seller_id)` 唯一 | user_id、seller_id、status、interval_seconds、next_run_at | `user_id, status, next_run_at, id` |
| `task_event_links` | `(task_id, event_id)` 复合主键 | matched_at、rule_version | `event_id, task_id` |
| `ai_capabilities` | `id uuid`；`code` 唯一 | published version、input schema、output schema、entitlement | User API 仅返回已发布能力 |
| `ai_prompt_versions` | `id uuid`；`(capability_id, version)` 唯一 | provider ref、model ref、prompt、status、published_at | 仅 Admin API 可读写完整内容 |
| `ai_jobs` | `id uuid`；`(requesting_user_id, idempotency_key)` 唯一 | capability/version、input object ref、status、queued/started/finished time、billing ref | 第 5 节按月分区；`status, created_at`；`requesting_user_id, created_at desc, id desc` |
| `ai_insights` | `id uuid`；`(ai_job_id, insight_type)` 唯一 | result JSON、confidence、model/prompt version、created_at | `entity_ref, created_at desc, id desc` |
| `audit_logs` | `id uuid` | actor_type/id、action、target type/id、request_id、IP hash、safe metadata、occurred_at | 第 5 节按月分区；`actor_type, actor_id, occurred_at desc, id desc`；不可 UPDATE/DELETE |

用户 Web 没有 AI 提供方、模型密钥、提示词、阈值或队列配置接口；这些实体只能通过独立 Admin API 管理。采集器没有商品池、竞品、AI 配置或上传状态页面，上传明细仅由 Admin 从 `ingest_batches` 等实体查看。

## 5. 分区、保留和数据生命周期

### 5.1 必须按月 RANGE 分区的追加表

- `market_observations`（按 `collected_at`）
- `market_item_events`（按 `occurred_at`）
- `dynamic_logs`（按 `occurred_at`）
- `usage_ledger`（按 `occurred_at`）
- `ai_jobs`（按 `created_at`）
- `audit_logs`（按 `occurred_at`）

分区提前创建：当前月加未来至少 3 个月；归档/删除仅按整月分区执行，不能对热表逐行删除。每个分区都必须有本表主键、实体时间线索引和 Admin 时间筛选索引。`market_items`、`seller_profiles`、`users`、`orders` 等当前态/低基数表不分区。

### 5.2 生命周期字段必须在阶段 0 填实

阶段方案和当前源码未给出数值，不能凭空设定。建库门禁是下表全部由产品负责人确认，写入环境无关的容量配置与保留策略文档：

| 必填项 | 定义 | 阶段 1 前必须冻结的值 |
| --- | --- | --- |
| 热数据保留期 | 在线可查询的 observation/event/log/月数 | 6 个月 |
| 归档保留期 | 压缩归档与可恢复的最长时长 | 18 个月 |
| 审计保留期 | 不可删除审计记录的时长 | 24 个月 |
| 原始公开快照保留期 | 对象存储页面快照的保留时长 | 90 天 |
| 图片存储保留期 | 去重媒体对象与引用清理规则 | 18 个月 |
| 备份 RPO / RTO | 最大可丢数据与最大恢复时间 | 15 分钟 / 4 小时 |

对象删除需要引用计数为零、超过保留窗口且有删除审计；不能因单个商品版本被清理就误删仍被其他版本引用的图片。

## 6. 统一服务端游标分页合同

所有列表端点（用户、Admin 和动态日志）均使用下列契约；禁止 offset 分页、禁止客户端对全量数据再分页。

```text
GET /v1/<resource>?limit=50&cursor=<opaque>&sort=<field>&order=desc&<filters>

200 {
  "items": [...],
  "page": {
    "limit": 50,
    "nextCursor": "opaque-or-null",
    "hasMore": true,
    "total": 1234,
    "snapshot": "opaque-read-watermark"
  }
}
```

规则：

1. `limit` 只允许 `20`、`50`、`100`，默认 `50`；服务端强制上限 `100`。
2. Cursor 是服务端签名的不透明值，至少绑定资源类型、已规范化筛选条件哈希、排序、排序方向、读水位和最后一条的完整排序元组；客户端不得构造或修改。
3. 每种排序必须追加不可变唯一 ID 作为末级排序。例如：`occurred_at DESC, id DESC`，`price ASC, id ASC`，`created_at DESC, id DESC`。
4. 首页建立读水位；后续页必须复用它。索引读模型使用 PIT/等价快照，PostgreSQL 查询使用可重建的版本水位。翻页期间新增或更新的数据不进入当前翻页会话，避免漏项和重复；筛选或排序变化必须丢弃 cursor 并从首页重新开始。
5. `total` 是与该读水位一致的准确总量；其计算必须复用同一过滤索引。若任一资源无法在 SLO 内给出准确总量，阶段 0 不得批准该资源进入用户界面，不能偷偷改为全量或不稳定估算。
6. `nextCursor` 失效、筛选不匹配、读快照超时应返回明确的可重试错误码（例如 `CURSOR_EXPIRED`），客户端保留筛选并回到第一页；不得静默混入新旧结果。
7. 详情、图片和完整历史为按需端点，列表只返回表格/卡片所需字段。

## 7. 容量合同：字段、公式与 SLO 门禁

当前项目尚无生产实测量，因此采用 [PHASE0_CAPACITY_PROFILE.md](PHASE0_CAPACITY_PROFILE.md) 的 V1 工程基线；它是阶段 1 建库和压测的下限，真实上线样本只能触发后续容量变更，不能回退本合同。

### 7.1 业务输入

| 变量 | 含义 | 冻结值 |
| --- | --- | --- |
| `U_active` | 峰值活跃付费用户数 | 1,000 |
| `C_per_user` | 每用户峰值活跃采集器数 | 2 |
| `T_per_user` | 每用户峰值启用监控任务数 | 20 |
| `S_per_task_day` | 单任务每日扫描次数 | 12 |
| `I_per_scan_p50/p95` | 每次扫描解析商品数 | 30 / 60 |
| `Seller_per_user` | 每用户竞品卖家数 | 5 |
| `Seller_pages_per_day` | 单卖家每日抓取页数 | 4 |
| `Change_rate` | 商品/卖家产生新版本或事件的比例 | 3% |
| `Media_per_item` / `Media_bytes_p95` | 每商品图片数与 P95 图片大小 | 0.08 / 750 KB |
| `H_hot` / `H_archive` | 热数据与归档保留月数 | 6 / 18 |
| `R_peak_factor` | 峰值窗口相对平均值倍数 | 10 |
| `AI_calls_per_user_day` | 每用户每日 AI 调用数 | 10 |

### 7.2 派生容量

```text
daily_task_runs = U_active * T_per_user * S_per_task_day
daily_item_observations_p95 = daily_task_runs * I_per_scan_p95
daily_seller_observations = U_active * Seller_per_user * Seller_pages_per_day * I_per_scan_p95
daily_versions = (daily_item_observations_p95 + daily_seller_observations) * Change_rate
peak_ingest_rps = ((daily_item_observations_p95 + daily_seller_observations) / 86400) * R_peak_factor
hot_observation_rows = (daily_item_observations_p95 + daily_seller_observations) * days(H_hot)
monthly_media_bytes_p95 = daily_versions * Media_per_item * Media_bytes_p95 * days_in_month
```

容量表还必须给出：数据库行大小实测、索引放大系数、队列峰值积压时长、对象存储增长、搜索索引膨胀、数据库连接池上限、Worker 并发、缓存命中目标、备份大小和恢复窗口。所有值以压测生成数据和真实匿名样本校准，不能只用公式估计后宣布通过。

### 7.3 SLO 必填项

| 场景 | 必须冻结的指标 |
| --- | --- |
| 登录与令牌刷新 | P95/P99 延迟、错误率、峰值并发 |
| 采集批次接收 | 可持续 RPS、P95/P99、拒绝率、幂等命中正确率 |
| 用户商品/卖家/事件/日志分页 | 首页与下一页 P95/P99、准确 total、深分页页数 |
| Admin 查询 | 多条件筛选 P95/P99、导出必须走异步任务的阈值 |
| 队列 | 最大可接受积压、清空时长、重试上限和死信处理时间 |
| AI | 排队时长、执行时长、失败率、单次计费幂等性 |
| 可用性与恢复 | API/Worker 目标可用性、RPO、RTO、备份演练频率 |

数值已写入容量基线；实现方必须把它们写入压测配置、告警阈值和验收记录，避免「数据大了再改」。

## 8. 阶段 0 关闭验收

阶段 0 仅在下列证据齐全后关闭：

1. 本文与 `PHASE0_CAPACITY_PROFILE.md` 的容量与生命周期字段已冻结并版本化；域名保持占位。
2. PostgreSQL DDL 迁移在空库连续执行两次成功，第二次无变化；回滚/前滚策略经过一次演练。
3. 使用包含重复商品、重复上传、跨设备同商品、价格变更、下架、卖家变更、重复图片、异常载荷的固定样本，证明第 3.1 节的规范实体、版本、事件、媒体与账本去重键均有效。
4. 为商品、卖家、事件、动态日志和 Admin 审计各执行一次 `EXPLAIN (ANALYZE, BUFFERS)`；计划命中预期组合索引或搜索读模型，不允许无界顺序扫描或跨全分区扫描。
5. 分页契约测试覆盖第一页、连续多页、筛选/排序切换、深分页、翻页期间新增/更新、cursor 过期、空结果和失败重试，证明无重复、无漏项、总量与水位一致。
6. 基于第 7 节冻结的输入运行数据库、API、队列、对象存储和搜索压测；记录吞吐、P50/P95/P99、错误率、资源占用、队列积压和恢复结果，并逐项满足已签署 SLO。
7. 安全审计证明 User、Admin、collector 三个身份域不能越权；日志、批次、原始对象和备份没有密码、Token、Cookie 或浏览器 Profile。

未满足任一项时，本阶段仍是「进行中」，不得以 UI 页面、静态 ER 图或单机 SQLite 结果代替云端合同验收。
