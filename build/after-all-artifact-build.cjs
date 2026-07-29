// electron-builder hook：只信任本次 builder 返回的 artifactPaths，并生成同源桌面制品清单。
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { writeDesktopReleaseManifest } = require('../scripts/desktop-release-manifest.cjs')

exports.default = async function afterAllArtifactBuild(buildResult) {
  const artifactPaths = (buildResult.artifactPaths || []).filter(Boolean)
  if (artifactPaths.length === 0) {
    console.log('  • 桌面目录打包未生成发布制品，跳过 provenance manifest')
    return []
  }
  const { output } = writeDesktopReleaseManifest(buildResult)
  console.log(`  • 桌面制品 provenance manifest  file=${output}`)
  return [output]
}
