# 阶段 2：工作台基线记录

状态：**阶段 2 本地实现闭环已通过。**

## 已完成

- `apps/user-web` 是独立 Vite/React 产物，包含 Dashboard、我的监控、竞品商家、市场商品池、市场发现、事件中心、动态日志、AI 分析和账户设置。
- `apps/admin-web` 是独立 Vite/React 产物，包含运营概览、用户与设备、套餐订单用量、市场数据、类目数据质量、上传批次事件、AI 配置任务、队列存储容量与审计系统设置。
- 两端各有固定可收起侧栏、顶部状态栏、筛选栏、表格、分页控件、加载/空/失败状态和详情抽屉。用户端不存在 Admin 菜单、上传/同步状态、AI Provider、模型 Key 或提示词编辑入口。
- 两端分页 UI 统一为 `20 / 50 / 100`，筛选、排序或页大小变化会回到第一页。API 模式使用服务端 `limit + cursor + sort + filters`；本地 fixture 仅用于未配置云端时的交互预览。
- 云端服务补齐 `serve:cloud` 启动入口、PostgreSQL Pool 装配、独立 User/Admin/Collector 端口和 `.env.example`。User/Admin 工作台共 15 条列表路由使用签名 cursor、稳定排序、筛选绑定和快照隔离；User 读取按既有采集器、观测和 AI 任务关联进行归属过滤。
- User、Admin 登录、刷新令牌和 API Origin 分别配置。跨域仅接受环境变量白名单中的 Origin，预检不允许通配来源。

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
| 阶段 2 云端接口集成 | 通过，15 条 User/Admin 列表路由、身份隔离、用户归属过滤、刷新令牌、cursor、快照及 CORS 白名单均由 PGlite/Fastify 集成测试验证 |
| 主线最终复检 | `npm run check:cloud`、`npm run test:phase0:contract`、`npm run test:phase2:cloud`、两端 `vite build` 和 `git diff --check` 均通过 |

## 部署前置条件

1. 在目标环境配置真实 PostgreSQL、TLS 和三套域名后，按 `services/cloud/.env.example` 启动云端服务；缺少数据库配置时 `npm run serve:cloud` 会明确拒绝启动。
2. 本阶段未部署生产 PostgreSQL、真实域名或 TLS，也未将浏览器连接到真实远端数据库。上述工作属于部署验收，不能由本地 PGlite/Fastify 集成测试替代。
