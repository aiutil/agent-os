// 工作台页（SPEC-005 / v2）。镜头模式分段已上移到应用单侧栏（Dock）。
// 本页仅承载工作区主区（会话/CLI 镜头或 Hero 空态）。

import { WorkbenchMain } from './WorkbenchMain'
import './workbench.css'

export function WorkbenchPage(): React.JSX.Element {
  return (
    <div className="workbench">
      <WorkbenchMain />
    </div>
  )
}
