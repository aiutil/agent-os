; 安装更新前关闭正在运行的 Agent OS，避免文件占用导致覆盖失败。
!macro customInstall
  nsProcess::_CloseProcess "Agent OS.exe" $R0
  Sleep 2000
!macroend
