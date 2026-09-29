export function createDesktopInstallerArguments({ version, source, output, icon, splashImage }) {
  return [
    'pack',
    '--packId=GrayCode',
    '--packTitle=GrayCode',
    '--packAuthors=GrayCode contributors',
    `--packVersion=${version}`,
    `--packDir=${source}`,
    '--mainExe=GrayCode.exe',
    '--runtime=win-x64',
    '--channel=win-x64',
    `--outputDir=${output}`,
    `--icon=${icon}`,
    ...(splashImage ? [`--splashImage=${splashImage}`] : []),
    '--noPortable=true',
    '--shortcuts=StartMenuRoot',
  ];
}
