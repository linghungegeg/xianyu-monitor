# 阶段 0：闭环验收报告

执行日期：2026-08-17  
阶段状态：**通过，可进入阶段 1**  
域名：仅使用 `.placeholder.invalid` 占位，不含任何生产地址。

## 交付物

- [PHASED_DELIVERY_PLAN.md](PHASED_DELIVERY_PLAN.md)：三产品、分阶段交付与总体验收边界。
- [PHASE0_DATA_CONTRACT_REVIEW.md](PHASE0_DATA_CONTRACT_REVIEW.md)：实体、去重、事件、分页、数据生命周期和访问边界。
- [PHASE0_CAPACITY_PROFILE.md](PHASE0_CAPACITY_PROFILE.md)：V1 容量、存储推导、SLO 和占位域名。
- [0001_phase0_contract.sql](infra/postgres/migrations/0001_phase0_contract.sql)：PostgreSQL 数据合同迁移。
- [postgres-contract-test.mjs](tools/phase0/postgres-contract-test.mjs)：嵌入式 PostgreSQL 迁移与索引验收。
- [sqlite-synthetic-load.mjs](tools/phase0/sqlite-synthetic-load.mjs)：不触碰真实监控库的合成压力测试。

## 独立验证结果

### PostgreSQL 合同验证

`npm run test:phase0:contract` 通过：

- 同一迁移在干净的临时嵌入式 PostgreSQL 数据库连续执行两次成功。
- 创建 30 张实体表、24 个未来月表分区、100 条总继承关系（含分区索引）和 86 个索引。
- 商品状态排序的 keyset 查询命中 `idx_items_state_recent`。
- 云端合同中未出现 Cookie、浏览器 Profile、明文密码或原始 Token 列；仅保存本系统密码和会话 Token 的哈希。

### 合成压力测试

`npm run test:phase0:stress` 通过，参数为 100,000 规范商品、4 个设备、250 条/批次：

| 场景 | 输入记录 | 本次结果 |
| --- | ---: | ---: |
| 初始上报 | 400,000 | 143,197 条/秒 |
| 价格变更 | 133,332 | 92,948 条/秒 |
| 重复回放 | 533,332 | 826,692 条/秒 |
| 游标分页 | 100,000 / 1,031 页 | 41,312 条/秒 |

断言全部通过：跨设备商品去重、版本去重、事件去重、批次幂等、100,000 条连续分页无重复无漏项，且翻页中的新增商品没有混入旧读水位。

## 结论与边界

阶段 0 已关闭的是架构、数据、容量、迁移可重复性和本地合同压力验证。现有 Electron 原型没有被误认为云端实现：它仍只提供本地 Chrome 采集内核，阶段 3 才会收敛为采集启动器。

本次压力结果不等同于生产云压测：它不覆盖真实 PostgreSQL 集群、HTTP/API、多实例竞争、Redis、消息队列、对象存储、搜索索引或真实闲鱼吞吐。阶段 1 建成云端基础后，必须按 `PHASE0_CAPACITY_PROFILE.md` 重新进行完整基础设施压测，结果不满足 SLO 时不得关闭阶段 1。
