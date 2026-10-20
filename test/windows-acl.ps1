$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

try {
  if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Windows PowerShell 5.1 is required'
  }
  $data = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trustedSids = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')

  if ($data.action -eq 'inspect') {
    $items = @(foreach ($path in $data.paths) {
      $acl = Get-Acl -LiteralPath $path
      $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
      @{
        path = $path
        owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        protected = $acl.AreAccessRulesProtected
        nullDacl = $null -eq $raw.DiscretionaryAcl
        daclPresent = ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0
        sddl = $acl.Sddl
        aceTypes = @(if ($null -ne $raw.DiscretionaryAcl) { foreach ($ace in $raw.DiscretionaryAcl) { $ace.AceType.ToString() } })
        rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
          @{
            sid = $_.IdentityReference.Value
            type = $_.AccessControlType.ToString()
            rights = [int]$_.FileSystemRights
            inheritance = [int]$_.InheritanceFlags
            propagation = [int]$_.PropagationFlags
            inherited = $_.IsInherited
          }
        })
      }
    })
    $result = @{ currentSid = $currentSid.Value; items = $items }
  } elseif ($data.action -eq 'set') {
    $directory = (Get-Item -LiteralPath $data.path -Force).PSIsContainer
    $acl = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $inheritance = if ($directory) { [Security.AccessControl.InheritanceFlags]3 } else { [Security.AccessControl.InheritanceFlags]0 }
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $trustedSids) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        [Security.Principal.SecurityIdentifier]::new($sid),
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance, [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
      ))
    }
    switch ($data.mode) {
      'private' {}
      'public' {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
          [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
          [Security.AccessControl.FileSystemRights]::ReadAndExecute,
          $inheritance, [Security.AccessControl.PropagationFlags]::None,
          [Security.AccessControl.AccessControlType]::Allow
        ))
      }
      'broad' {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
          [Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
          [Security.AccessControl.FileSystemRights]::FullControl,
          $inheritance, [Security.AccessControl.PropagationFlags]::None,
          [Security.AccessControl.AccessControlType]::Allow
        ))
      }
      'deny' {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
          [Security.Principal.SecurityIdentifier]::new('S-1-5-32-546'),
          [Security.AccessControl.FileSystemRights]::Read,
          $inheritance, [Security.AccessControl.PropagationFlags]::None,
          [Security.AccessControl.AccessControlType]::Deny
        ))
      }
      'null' { $acl.SetSecurityDescriptorSddlForm('D:PNO_ACCESS_CONTROL', [Security.AccessControl.AccessControlSections]::Access) }
      default { throw 'Unknown fixture ACL mode' }
    }
    Set-Acl -LiteralPath $data.path -AclObject $acl
    $result = @{ ok = $true }
  } else {
    throw 'Unknown ACL fixture action'
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 10 -Compress))
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
