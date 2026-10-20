$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
  if ($env:ELUNE_TEST_WINDOWS_ACCOUNTS -ne '1') { throw 'Windows account tests require explicit permission' }
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Windows PowerShell 5.1 is required'
  }
  $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
  $name = [string]$data.name
  $marker = [string]$data.marker
  if ($name -notmatch '^elune_[0-9a-f]{12}$' -or $marker -notmatch '^elune-[0-9a-f-]{36}$') {
    throw 'Invalid temporary account identity'
  }
  function Remove-FixtureAccount {
    $existing = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
      if ($existing.Description -ne $marker) { throw 'Refusing to remove an unrelated account' }
      Remove-LocalUser -SID $existing.SID
      if (Get-LocalUser -SID $existing.SID -ErrorAction SilentlyContinue) { throw 'Temporary account still exists' }
    }
  }
  if ($data.action -eq 'cleanup') {
    Remove-FixtureAccount
    [Console]::Out.WriteLine('{"ok":true}')
    exit 0
  }
  if ($data.action -ne 'probe') { throw 'Unknown account fixture action' }
  if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { throw 'Temporary account name already exists' }
  $parentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $probe = @'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $data = [IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot, 'probe-input.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  function Test-FileAccess([string]$Path, [bool]$Write) {
    $stream = $null
    try {
      if ($Write) {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.WriteByte(1)
      } else {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
        $null = $stream.ReadByte()
      }
      return @{ path = $Path; exception = $null; win32 = 0 }
    } catch {
      $cause = $_.Exception.GetBaseException()
      return @{ path = $Path; exception = $cause.GetType().FullName; win32 = $cause.HResult -band 65535 }
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
    }
  }
  $result = @{
    sid = $identity.User.Value
    admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    groups = @($identity.Groups | ForEach-Object { $_.Value })
    control = [IO.File]::ReadAllText($data.control, [Text.Encoding]::UTF8)
    reads = @($data.files | ForEach-Object { Test-FileAccess $_ $false })
    write = Test-FileAccess $data.create $true
  }
  $null = [IO.Directory]::CreateDirectory($data.ownedDirectory)
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($data.parentSid, 'S-1-5-18', 'S-1-5-32-544')) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid),
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]3, [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    ))
  }
  Set-Acl -LiteralPath $data.ownedDirectory -AclObject $acl
  [IO.File]::WriteAllText($data.resultPath, ($result | ConvertTo-Json -Depth 6 -Compress), [Text.Encoding]::UTF8)
} catch {
  [IO.File]::WriteAllText([IO.Path]::Combine($PSScriptRoot, 'owner-fixture', 'probe-error.txt'), "Line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.GetBaseException().Message)", [Text.Encoding]::UTF8)
  exit 1
}
'@
  $bytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($bytes) } finally { $random.Dispose() }
  $password = ConvertTo-SecureString ('aB9-' + [Convert]::ToBase64String($bytes)) -AsPlainText -Force
  [Array]::Clear($bytes, 0, $bytes.Length)
  $account = $null
  $child = $null
  $started = $false
  try {
    $account = New-LocalUser -Name $name -Password $password -Description $marker -AccountExpires (Get-Date).AddMinutes(10) -UserMayNotChangePassword
    $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
    if (-not (Get-LocalGroupMember -SID $users | Where-Object { $_.SID -eq $account.SID })) {
      Add-LocalGroupMember -SID $users -Member $account
    }
    $probePath = Join-Path $data.root 'account-probe.ps1'
    $resultPath = Join-Path $data.root 'owner-fixture\probe-result.json'
    $errorPath = Join-Path $data.root 'owner-fixture\probe-error.txt'
    $inputData = @{
      parentSid = $parentSid
      control = $data.control
      files = $data.files
      create = $data.create
      ownedDirectory = $data.ownedDirectory
      resultPath = $resultPath
    } | ConvertTo-Json -Depth 4 -Compress
    [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($true))
    [IO.File]::WriteAllText((Join-Path $data.root 'probe-input.json'), $inputData, [Text.Encoding]::UTF8)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $probePath + '"'
    if (('"' + $start.FileName + '" ' + $start.Arguments).Length -ge 1024) {
      throw 'Alternate-credential command must be shorter than 1024 characters'
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.LoadUserProfile = $false
    $start.UserName = $name
    $start.Domain = $env:COMPUTERNAME
    $start.Password = $password
    $start.WorkingDirectory = $data.root
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    $started = $child.Start()
    if (-not $started) { throw 'Alternate-credential child did not start' }
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(20000)) { throw 'Alternate-credential child timed out' }
    $childOutput = $stdout.GetAwaiter().GetResult()
    $childError = $stderr.GetAwaiter().GetResult()
    if ([IO.File]::Exists($errorPath)) { throw ('Alternate-credential child failed: ' + [IO.File]::ReadAllText($errorPath, [Text.Encoding]::UTF8)) }
    if ($child.ExitCode -ne 0 -or -not [IO.File]::Exists($resultPath)) { throw ('Alternate-credential child did not return a result: ' + $childError + $childOutput) }
    $result = [IO.File]::ReadAllText($resultPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($null -eq $result) { throw 'Alternate-credential child returned an empty result' }
    $result | Add-Member -NotePropertyName expectedSid -NotePropertyValue $account.SID.Value
    $result | Add-Member -NotePropertyName parentSid -NotePropertyValue $parentSid
  } finally {
    try {
      if ($started -and -not $child.HasExited) {
        $child.Kill()
        if (-not $child.WaitForExit(5000)) { throw 'Alternate-credential child did not stop' }
      }
    } finally {
      try {
        Remove-FixtureAccount
      } finally {
        if ($null -ne $child) { $child.Dispose() }
        $password.Dispose()
      }
    }
  }
  $result | Add-Member -NotePropertyName accountRemoved -NotePropertyValue $true
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
} catch {
  [Console]::Error.WriteLine("Line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.GetBaseException().Message)")
  exit 1
}
