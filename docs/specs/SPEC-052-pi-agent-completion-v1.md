# SPEC-052 Pi 全流程结束与工具事件

状态：implemented，自动化 QA pass，隔离真机运行通过；进入修复分支交付，未合并主分支、未发布版本。授权：2026-10-05 用户同意修复，并明确同意提交、推送 future/pi-agent-completion 分支。关联 SPEC-019 / SPEC-039 / SPEC-048。

## 背景与证据
参赛演示中 Pi 读取 README 并产出最终回复，但任务在第一轮工具执行后已进入 Review。当前适配器把 Pi 的每个 turn_end 映射为宿主 turn-end。已安装 Pi 的 AgentEvent 协议中 turn_end 是内部模型/工具轮次，agent_end 才是整个 agent 循环结束。

## 范围与设计
- 只改 Pi 控制面和回归测试。不改 UI、IPC、共享契约、任务持久化、账号设置、其他 CLI，不回填旧任务。
- turn_end 不发送宿主结束；agent_end 仅发送一次 completed。进程非零退出沿用 ChatManager 错误处理。
- 原生 tool_execution_start/end 映射现有 tool-start/result，保留调用 ID、参数、文本结果和错误标志；同类重复事件去重。保留旧格式兼容。
- 文本与思考继续增量映射，未知/损坏输入不抛异常。无新数据结构或 IPC。
- 实施顺序：协议核实 → parser → 合成协议及 ChatManager 集成回归 → 独立 QA → 真机重新运行。

## 验收
1. 多个工具轮次的 turn_end 不使宿主 idle；最终文本到达后 agent_end 才完成，且重复 agent_end 不重复完成。
2. 原生工具起止能进入时间线，错误结果不被标为成功工具结果，非文本结果不崩溃。
3. 最终回复保留完整，session 绑定、坏 JSON、文本/思考及旧事件兼容。
4. qa-verify 独立运行 npm test、npm run typecheck、npm run build，报告原始 verdict + evidence。
5. 真机演示需新运行验证，不能凭单测或旧记录宣称视频已通过。

## 风险
不同 Pi 版本或扩展可能改变事件；本次依据本机实际安装协议并加合成回归。其他 CLI、失败重试策略与全局 ChatManager 改造不在范围。

## 独立验证 2026-10-05
qa-verify（独立上下文）对最终 history() 版本完整重跑：verdict pass。
- npm test：exit 0；112 files passed，1 skipped；709 tests passed，7 skipped，0 failed。
- npm run typecheck：exit 0，node/web 均通过。
- npm run build：exit 0，main/preload/renderer 均成功。
- 专项：chat-manager 16 tests，chat-pi 3 tests。
- 产品和测试文件的验证前后 SHA-256 一致。
- 限制：集成测试的 timeline.length 断言较宽，工具字段由 parser 精确断言和 QA 代码检查覆盖；未执行真实账号/UI测试。
- 自动化 QA 完成当时桌面锁定；后续真机验证见下一节。原来的 Pi 任务未伪造回填或确认完成。

## 真机补充验收 2026-10-05 08:37–08:41
- 解锁后重新加载补丁构建，隔离 userData，不操作个人正式应用的数据。
- 原 Pi 功能清单任务重新执行，bash/read 工具事件及最终八行表格均到达交付物，未因内部工具轮次提前结束。内容存在推测，保留 Review。
- 新建“Pi：摘录公开使用边界”：实际读取公开 README，三条引文与源文件第70–77行逐条核对一致，交付后人工点击确认完成，任务进入 Done。
- Claude Code 另行读取同一 README 返回引文和解释，最终交付可见；此项仅作对照演示，仍待人工审阅，不是 Pi 补丁范围。
- 窗口录屏证据：Openscreen recording-1791160768105.mp4，116.016667秒、2560×1664；视频工程另存 private-captures/pi-claude-real-20261005.mp4。
- 本节是主代理真实 UI 操作补充证据；自动化验收仍以上述独立 qa-verify verdict 为准。修复分支交付不代表已合并主分支或发布版本。
