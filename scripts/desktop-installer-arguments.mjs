export function createDesktopInstallerArguments({ version, source, output, icon }) {
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
    '--noPortable=true',
    '--shortcuts=StartMenuRoot',
  ];
}
