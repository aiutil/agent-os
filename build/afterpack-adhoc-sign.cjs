// electron-builder afterPack 钩子：对 macOS .app 做 ad-hoc 签名。
//
// 背景：我们没有 Apple Developer ID 证书，electron-builder 会跳过签名。
// 完全未签名的 arm64 应用在本机直接无法运行（dyld 拒绝加载未签名代码）。
// ad-hoc 签名（codesign --sign -）不依赖任何证书/账号，能让 app 在去除
// quarantine 后正常启动，避免「已损坏，无法打开」。
//
// 注意：ad-hoc 仍不被 Gatekeeper 信任，用户从浏览器下载后仍需去 quarantine
// （xattr -rd com.apple.quarantine）或右键「打开」。要彻底零提示需正式签名+公证。
const path = require('node:path')
const { execFileSync } = require('node:child_process')

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context
  if (electronPlatformName !== 'darwin') return

  const appName = packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)

  // --force 覆盖已有（含 electron 自带）签名；--deep 连带签名内部 Helper/Framework；
  // --sign - 表示 ad-hoc（无证书）。--timestamp=none 避免联网打时间戳失败。
  console.log(`  • ad-hoc 签名 macOS app  file=${appPath}`)
  execFileSync(
    'codesign',
    ['--force', '--deep', '--timestamp=none', '--sign', '-', appPath],
    { stdio: 'inherit' }
  )

  // 校验签名有效，签坏了直接让打包失败而不是产出坏包。
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('  • ad-hoc 签名校验通过')
}
