using namespace System.IO
using namespace System.Security.AccessControl
using namespace System.Security.Principal
using namespace System.Text

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [UTF8Encoding]::new($false)

function Get-PrivateAccess([string]$path, [bool]$directory) {
    $attributes = [File]::GetAttributes($path)
    if (($attributes -band [FileAttributes]::ReparsePoint) -or ([bool]($attributes -band [FileAttributes]::Directory) -ne $directory)) {
        throw 'Database storage must contain regular files and directories without reparse points'
    }
    $sections = [AccessControlSections]'Access, Owner'
    $acl = if ($directory) { [Directory]::GetAccessControl($path, $sections) } else { [File]::GetAccessControl($path, $sections) }
    $problem = if ($directory) { 'Database directory must have private Windows permissions' } else { 'Database files must have private Windows permissions' }
    if ($acl.GetOwner([SecurityIdentifier]).Value -notin $trustedSids) { throw $problem }
    $descriptor = [RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $descriptor.DiscretionaryAcl -or -not ($descriptor.ControlFlags -band [ControlFlags]::DiscretionaryAclPresent)) { throw $problem }
    $fullAccess = $false
    $inheritedAccess = $false
    foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace -isnot [CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne [AceQualifier]::AccessAllowed) { throw $problem }
        if ($ace.SecurityIdentifier.Value -notin $trustedSids) { throw $problem }
        if ($ace.SecurityIdentifier.Value -eq $currentSid.Value -and ($ace.AccessMask -band $fullControl) -eq $fullControl) {
            $flags = [int]$ace.AceFlags
            if (($flags -band [int][AceFlags]::InheritOnly) -eq 0) { $fullAccess = $true }
            if (($flags -band $inheritance) -eq $inheritance -and ($flags -band [int][AceFlags]'InheritOnly, NoPropagateInherit') -eq 0) { $inheritedAccess = $true }
        }
    }
    if (-not $fullAccess -or ($directory -and -not $inheritedAccess)) { throw $problem }
    return $acl
}

function Assert-DatabaseFiles([string]$databasePath) {
    foreach ($suffix in @('', '-wal', '-shm')) {
        $path = $databasePath + $suffix
        if (Test-Path -LiteralPath $path) { $null = Get-PrivateAccess $path $false }
    }
}

try {
    $databasePath = [Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
    if ($databasePath -match '[. ]([\\/]|$)') { throw 'Database path must not contain components ending in a period or space' }
    if ($databasePath.Substring([Path]::GetPathRoot($databasePath).Length).Contains(':')) { throw 'Database path must not contain alternate data streams' }
    $directory = [Path]::GetDirectoryName($databasePath)
    $currentSid = [WindowsIdentity]::GetCurrent().User
    $trustedSids = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $fullControl = [int][FileSystemRights]::FullControl
    $inheritance = [int][AceFlags]'ContainerInherit, ObjectInherit'
    $ancestor = $directory
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $attributes = [File]::GetAttributes($ancestor)
            if (-not ($attributes -band [FileAttributes]::Directory) -or ($attributes -band [FileAttributes]::ReparsePoint)) {
                throw 'Database directory path must contain only directories without reparse points'
            }
        }
        $ancestor = [Path]::GetDirectoryName($ancestor)
    }
    $security = [DirectorySecurity]::new()
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in $trustedSids) {
        $rule = [FileSystemAccessRule]::new([SecurityIdentifier]::new($sid), [FileSystemRights]::FullControl, [InheritanceFlags]'ContainerInherit, ObjectInherit', [PropagationFlags]::None, [AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }
    [void][Directory]::CreateDirectory($directory, $security)
    $acl = Get-PrivateAccess $directory $true
    Assert-DatabaseFiles $databasePath
    if (-not $acl.AreAccessRulesProtected) {
        $acl.SetAccessRuleProtection($true, $true)
        [Directory]::SetAccessControl($directory, $acl)
        $acl = Get-PrivateAccess $directory $true
    }
    if (-not $acl.AreAccessRulesProtected) { throw 'Database directory must have a protected Windows ACL' }
    Assert-DatabaseFiles $databasePath
    exit 0
} catch {
    [Console]::Error.WriteLine("Line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.GetBaseException().Message)")
    exit 1
}
