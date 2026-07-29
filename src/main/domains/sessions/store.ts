// 会话元数据仓储（SPEC-005）。SPEC-017 后委托给 conversation-store。
// 保持原有函数签名，内部从 Conversation 模型派生。

export {
  listSessions,
  getSession,
  createSession,
  bindNativeSession,
  updateSession,
  attachTerminal,
  removeSession
} from './conversation-store'
