# Transcript Test Fixtures

- `claude/<version>/`、`codex/<version>/`：由真实 CLI 会话文件经
  `npm run fixture:scrub` 确定性脱敏生成。保留记录结构、角色、版本和时间戳；
  自由文本、路径、邮箱、密钥与身份标识全部替换。
- `synthetic/`：手工合成数据，用于坏行、未知记录与性能边界测试。

任何真实文件进入本目录前必须经过脱敏脚本，禁止手工复制原始会话。
