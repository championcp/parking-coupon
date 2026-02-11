# Parking Coupon (停车券系统)

一个基于 Node.js + Express 的停车券管理系统，支持管理员登录、创建停车券二维码、展码核销、使用次数扣减，以及后台历史券分页查询。

## 1. 功能概览

- 管理员登录（固定账号）
  - 用户名：`qzadmin`
  - 密码：`Qzkj@2026#`
- 停车券创建
  - 录入总次数，生成券号与二维码
  - 返回可直接访问的使用页链接
- 手动上传停车场二维码
  - 管理员可在后台为停车券上传二维码图片
  - 使用页展码优先展示手动上传二维码（未上传时回退自动二维码）
- 停车券使用（展码 + 确认扣减）
  - 展示券二维码
  - 每次确认使用扣减 1 次
  - 次数不足时返回错误
- 权限保护
  - 未登录无法访问 `redeem.html`
  - 未登录无法访问 `/api/voucher/*`
- 后台历史停车券
  - 展示每张券：总次数、已用次数、剩余次数、创建时间、预警状态
  - 支持搜索与分页（10/20/50）
- 内部回归测试
  - 一键执行 `npm test` 覆盖核心业务流程

## 2. 技术栈

- Node.js (ESM)
- Express 5
- fs-extra（文件存储）
- nanoid（券号随机后缀）
- qrcode（二维码生成）

## 3. 项目结构

```text
parking-coupon/
├── server.js                 # 后端服务与 API
├── data/
│   ├── vouchers.json         # 停车券数据
│   └── logs.jsonl            # 行为日志（JSONL）
├── public/
│   ├── index.html            # 入口页
│   ├── admin.html            # 管理后台（登录、发券、历史分页）
│   ├── redeem.html           # 使用页（展码、确认扣减）
│   └── styles.css            # 统一样式
├── scripts/
│   └── internal-regression.mjs  # 内部回归测试脚本
├── package.json
└── README.md
```

## 4. 快速开始

### 4.1 安装依赖

```bash
npm install
```

### 4.2 启动服务

```bash
node server.js
```

默认端口：`8080`

### 4.3 访问页面

- 入口页：`http://localhost:8080/`
- 后台：`http://localhost:8080/admin.html`
- 使用页：`http://localhost:8080/redeem.html`（需登录后可访问）

## 5. 配置项

支持以下环境变量：

- `PORT`：服务端口（默认 `8080`）
- `DATA_DIR`：数据目录（默认 `<项目根>/data`）

示例：

```bash
PORT=9090 DATA_DIR=/tmp/parking-coupon-data node server.js
```

## 6. 使用流程

### 6.1 管理员发券

1. 打开后台页面并登录
2. 输入总次数（或使用快捷按钮）
3. 点击“生成二维码”
4. 复制生成的使用链接，发给前台/车主

### 6.2 前台核销

1. 打开使用页（可带参数 `?v=券号`）
2. 点击“加载并展码”
3. 收费员扫码后，点击“确认使用 -1”
4. 查看剩余次数变化

### 6.3 历史管理

在后台“历史停车券”模块中可：

- 查看每张券总次数、已用次数、剩余次数
- 通过券号关键字搜索
- 分页查看大量数据

## 7. API 说明

### 7.1 管理员认证

- `POST /api/admin/login`
  - body: `{ "username": "qzadmin", "password": "Qzkj@2026#" }`
- `GET /api/admin/session`
- `POST /api/admin/logout`

### 7.2 管理员发券与历史

- `POST /api/admin/voucher`
  - body: `{ "total": 50, "manualQrDataUrl": "data:image/png;base64,..." }`
  - `manualQrDataUrl` 可选，支持 `PNG/JPEG/WEBP`
  - 返回：`voucher`, `redeemUrl`, `redeemFullUrl`, `qrDataUrl`, `voucherQrSource`
- `POST /api/admin/voucher/:id/manual-qr`
  - body: `{ "qrDataUrl": "data:image/png;base64,..." }`
  - 为指定停车券上传/更新手动二维码
- `GET /api/admin/vouchers?page=1&pageSize=10&q=关键词`
  - 返回：
    - `items[]`：每张券 `id/total/used/remain/status/createdAt/qrSource/manualQrUploadedAt/warning`
    - `pagination`：分页信息
    - `summary`：汇总统计

### 7.3 停车券使用 API（登录后）

- `GET /api/voucher/:id`：查询券详情（返回 `qrDataUrl` 与 `qrSource`）
- `POST /api/voucher/:id/display`：记录展码行为
- `POST /api/voucher/:id/confirm`：确认使用并扣减（返回 `qrDataUrl` 与 `qrSource`）

## 8. 数据存储说明

### 8.1 `data/vouchers.json`

以券号为 key 的对象存储：

```json
{
  "VCH_20260210_ABC123": {
    "id": "VCH_20260210_ABC123",
    "total": 50,
    "remain": 49,
    "createdAt": "2026-02-10T12:00:00.000Z",
    "status": "active",
    "manualQr": {
      "dataUrl": "data:image/png;base64,...",
      "uploadedAt": "2026-02-11T08:30:00.000Z",
      "uploadedBy": "qzadmin"
    }
  }
}
```

### 8.2 `data/logs.jsonl`

每行一条 JSON 日志，记录登录、创建、展码、核销等行为。

## 9. 内部测试

执行：

```bash
npm test
```

测试覆盖：

- 登录/登出与会话
- 未登录权限拦截
- 发券流程
- 展码与确认扣减
- 次数耗尽错误分支
- 历史查询与分页

## 10. 常见问题

### Q1: 后台提示 `Unauthorized`

通常是未登录或会话过期。请重新在 `admin.html` 登录。

### Q2: `localhost` 打不开

请确认服务进程仍在运行，并尝试：`http://127.0.0.1:8080/admin.html`

### Q3: 为什么 `redeem.html` 会跳回登录页

这是安全设计，防止未授权查看券信息和盗刷。

## 11. 免责声明

当前账号密码固定写在代码中，适合内部/演示环境。若用于生产，请改为安全的用户体系（密码哈希、角色权限、持久化会话、审计与风控）。
