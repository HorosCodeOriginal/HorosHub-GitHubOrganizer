$w = New-Object -ComObject WScript.Shell
$proj = 'C:\Users\Administrator\Repollection\GithubAssistent'
$exe = Join-Path $proj 'node_modules\electron\dist\electron.exe'
$ico = Join-Path $proj 'build\icon.ico'
$locs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($loc in $locs) {
  $old = Join-Path $loc 'HorosHub.lnk'
  if (Test-Path $old) { Remove-Item $old -Force }
  $lnk = $w.CreateShortcut((Join-Path $loc 'HorosHub - GithubOrganizer.lnk'))
  $lnk.TargetPath = $exe
  $lnk.Arguments = '"' + $proj + '"'
  $lnk.WorkingDirectory = $proj
  $lnk.IconLocation = $ico
  $lnk.Description = 'HorosHub - GithubOrganizer'
  $lnk.Save()
  Write-Output ('shortcut: ' + (Join-Path $loc 'HorosHub - GithubOrganizer.lnk'))
}