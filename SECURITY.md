# Security

## 数据边界

- 只读本机 `$DSH_HOME/sessions` 下的会话日志；
- 只写 `memRoot`（默认 `<DSH_HOME>/memory`）下的 SQLite 文件；
- 不发起任何网络请求，不调用任何模型；
- 不收集遥测。

## 写守卫

`memory_add` 和 CLI 会拒绝疑似密钥/令牌（`sk-`、`ghp_`、`github_pat_`、`AKIA`、`AKID`、
`xox[baprs]-`、私钥块）。确实需要存储时使用 `--allow-secret`，并自行确认目标位置。

## 本地 HTTP 接口

插件注册了 4 条只读/管理接口（`/memory-anchor/stats|search|export|manage`），由
DeepSeek Harness 的 web 服务托管，仅本机访问。`manage` 只支持软删和标记纠正，
不提供物理删除。

## 报告漏洞

在仓库的 issue 中私下报告（不要公开粘贴用户数据）。当前仓库地址待发布时补充。