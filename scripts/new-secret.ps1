param([int]$Bytes = 48)
$b = New-Object byte[] $Bytes
(New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b)
[Convert]::ToBase64String($b)