# 停车券管理系统

企业停车券使用追踪管理后台。假设已与物业系统完成 API 对接，实现实时使用追踪、按年/月/日查询使用明细、仪表盘统计等功能。

## 业务背景

企业向物业购买停车券（固定二维码，N 次使用权），将二维码打印放置于前台供员工扫码使用。物业系统在用户扫码后通过 Webhook 回调通知本系统，系统自动记录使用明细并扣减剩余次数。

**当前版本为 Demo**，通过管理后台的"模拟使用"按钮代替真实物业 API 回调。

## 功能概览

### 管理后台（SaaS 风格单页应用）

| 模块 | 功能 |
|------|------|
| **仪表盘** | 4 个主指标（购买记录数/总购买次数/总已用/总剩余）、4 个辅助指标（今日/本月/本年使用、已停用数）、近 7 天使用趋势柱状图、快捷入口 |
| **录入购买** | 录入向物业购买的停车券：购买次数 + 上传物业提供的固定二维码图片 + 备注 |
| **使用记录** | 按日期查询使用明细（今日/本周/本月/本年/全部/自定义日期范围）、汇总统计、CSV 导出 |
| **券管理** | 购买记录列表（搜索/状态筛选/分页）、详情弹窗（QR 码、使用进度、模拟使用、修正剩余次数-对账、停用/启用）、CSV 导出 |
| **操作日志** | 全部操作记录（登录/录入/物业API回调/手动使用/修正/停用），按类型和记录号筛选 |

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/admin/login` | 管理员登录 |
| `GET` | `/api/admin/session` | 会话检查 |
| `POST` | `/api/admin/logout` | 登出 |
| `POST` | `/api/admin/voucher` | 录入购买记录（multipart，含 QR 图片上传） |
| `GET` | `/api/admin/voucher/:id` | 购买记录详情 |
| `PUT` | `/api/admin/voucher/:id` | 更新记录（备注/状态/修正剩余次数） |
| `DELETE` | `/api/admin/voucher/:id` | 停用记录 |
| `POST` | `/api/admin/voucher/:id/use` | 管理员手动记录使用（模拟物业回调） |
| `GET` | `/api/admin/vouchers` | 购买记录列表（搜索/筛选/分页） |
| `GET` | `/api/admin/stats` | 仪表盘统计（含日/月/年使用量和 7 天趋势） |
| `GET` | `/api/admin/usages` | 使用记录查询（日期范围/记录号筛选/分页） |
| `GET` | `/api/admin/usages/export` | 使用记录 CSV 导出 |
| `GET` | `/api/admin/logs` | 操作日志（类型/记录号筛选/分页） |
| `GET` | `/api/admin/export` | 购买记录 CSV 导出 |
| `POST` | `/api/webhook/usage` | 物业系统 Webhook 回调端点 |

## 技术栈

- **后端**: Node.js (ESM) + Express 5
- **前端**: 原生 HTML/CSS/JavaScript (ES Modules)，SaaS 风格单页应用
- **数据存储**: 文件存储（`vouchers.json` + `usages.jsonl` + `logs.jsonl` + `qr/` 图片目录）
- **安全**: `crypto.scrypt` 密码哈希、HttpOnly Cookie 会话、CSRF Token 保护、IP 登录限流、安全响应头

## 快速开始

### 环境要求

- Node.js >= 18

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/championcp/parking-coupon.git
cd parking-coupon

# 安装依赖
npm install

# 启动服务器
npm start
```

服务器默认运行在 `http://localhost:8080`。

### 默认管理员账号

| 账号 | 密码 |
|------|------|
| `qzadmin` | `Qzkj@2026#` |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 服务端口 |
| `DATA_DIR` | `./data` | 数据存储目录 |
| `WEBHOOK_KEY` | `demo-webhook-key-2026` | 物业系统 Webhook 认证密钥 |

## 项目结构

```
├── server.js                    # 后端入口（API + 静态服务）
├── package.json
├── public/
│   ├── admin.html               # 管理后台（单页应用）
│   ├── index.html               # 首页（跳转到管理后台）
│   ├── styles.css               # 全局样式
│   └── js/
│       ├── admin.js             # 管理后台逻辑
│       ├── api.js               # API 请求封装
│       ├── utils.js             # 工具函数
│       └── toast.js             # Toast 通知组件
├── scripts/
│   └── internal-regression.mjs  # 回归测试（39项）
└── data/                        # 运行时自动创建
    ├── vouchers.json            # 购买记录
    ├── usages.jsonl             # 使用明细
    ├── logs.jsonl               # 操作日志
    └── qr/                      # QR 码图片
```

## 数据模型

### 购买记录 (`vouchers.json`)

```json
{
  "VCH_20260211_XXXXXX": {
    "id": "VCH_20260211_XXXXXX",
    "total": 100,
    "remain": 95,
    "status": "active",
    "note": "XX物业第1批",
    "createdAt": "2026-02-11T07:00:00Z",
    "lastUsedAt": "2026-02-11T08:30:00Z",
    "qrFile": "VCH_20260211_XXXXXX.png",
    "qrMimeType": "image/png"
  }
}
```

### 使用明细 (`usages.jsonl`)

每次使用产生一条独立记录：

```json
{ "id": "USE_20260211_XXXXXX", "voucherId": "VCH_...", "usedAt": "2026-02-11T08:30:00Z", "source": "api" }
```

- `source: "api"` — 来自物业系统 Webhook 回调
- `source: "manual"` — 管理员手动录入

## Webhook 对接说明

物业系统在用户扫码使用后，向以下端点发送 POST 请求：

```
POST /api/webhook/usage
Headers: X-Webhook-Key: <WEBHOOK_KEY>
Body: { "voucherId": "VCH_..." }  // 可选，不传则自动选取活跃券
```

响应：

```json
{ "ok": true, "usage": { "id": "USE_...", "voucherId": "VCH_...", "usedAt": "...", "source": "api" }, "remain": 99 }
```

## 测试

```bash
npm test
```

运行 39 项回归测试，覆盖：
- 认证/CSRF/登录限流
- 购买记录 CRUD
- Webhook 使用回调（创建使用记录 + remain-1）
- 管理员手动记录使用
- 使用到 0 后拒绝
- 使用记录按日期查询
- 增强的 Stats（今日/本月/本年 + 7 天趋势）
- 购买记录/使用记录 CSV 导出
- 停用/启用
- 登出

## License

ISC
