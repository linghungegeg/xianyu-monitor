# 阶段 2：工作台基线记录

状态：**工作台 UI 基线已验证；阶段全量验收尚未通过。**

## 已完成

- `apps/user-web` 是独立 Vite/React 产物，包含 Dashboard、我的监控、竞品商家、市场商品池、市场发现、事件中心、动态日志、AI 分析和账户设置。
- `apps/admin-web` 是独立 Vite/React 产物，包含运营概览、用户与设备、套餐订单用量、市场数据、类目数据质量、上传批次事件、AI 配置任务、队列存储容量与审计系统设置。
- 两端各有固定可收起侧栏、顶部状态栏、筛选栏、表格、分页控件、加载/空/失败状态和详情抽屉。用户端不存在 Admin 菜单、上传/同步状态、AI Provider、模型 Key 或提示词编辑入口。
- 两端分页 UI 统一为 `20 / 50 / 100`，筛选、排序或页大小变化会回到第一页。当前数据是本地 fixture，只用于工作台交互验证，不代表服务端 keyset cursor 已接通。
- 云端服务补齐 `serve:cloud` 启动入口、PostgreSQL Pool 装配、独立 User/Admin/Collector 端口和 `.env.example`。访问令牌的会话校验现同时验证 `subject_type` 与 `subject_id`，设备绑定也验证用户会话仍有效。

## 已验证

| 项目 | 结果 |
| --- | --- |
| `npm --prefix apps/user-web run build` | 通过 |
| `npm --prefix apps/admin-web run build` | 通过 |
| `npm run check:cloud` | 通过 |
| `npm run test:phase0:contract` | 通过，迁移重复执行、32 表、24 分区、92 索引 |
| 身份域内存集成 | 用户注册与 `/v1/me` 为 `200`；用户令牌访问 Admin 为 `403`；刷新为 `200`；刷新令牌重放为 `401` |
| 桌面浏览器渲染 | User/Admin 均通过 1440x900 截图检查 |
| 移动浏览器渲染 | User/Admin 均通过 390x844 检查，页面级横向溢出为 `false` |
| 工作台交互 | 两端导航、每页 50 条选择与详情抽屉已由 Playwright 验证 |

## 阶段门禁剩余项

1. 配置实际 PostgreSQL、TLS 和三套真实域名后启动云端服务；当前无数据库连接配置时 `npm run serve:cloud` 会明确拒绝启动。
2. 将 User Web 与 Admin Web 的登录页面、HTTP 客户端和真实服务端 `limit + cursor + sort + filters` 接口接通。当前 UI 的 fixture 不得视为云端分页或独立登录已完成。
3. 对接后重跑跨域身份、登录/刷新、服务端 cursor、筛选重置与两端浏览器验收，才可将阶段 2 标记为通过并进入阶段 3。
