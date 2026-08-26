function Get-LanIPv4 {
    # Picks the first "real" network adapter address, skipping loopback,
    # link-local (169.254.x.x self-assigned), and virtual adapters (VPNs,
    # Hyper-V, VMware, Docker) that would give the tablet an address nothing
    # on the restaurant's WiFi can actually reach.
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual|VPN|Hyper-V'
        }

    if (-not $candidates) { return $null }

    $preferred = $candidates | Where-Object { $_.InterfaceAlias -match 'Wi-?Fi|Ethernet' } | Select-Object -First 1
    if ($preferred) { return $preferred.IPAddress }

    return ($candidates | Select-Object -First 1).IPAddress
}

function Get-AllLanIPv4 {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.IPAddress -notlike '169.254.*' -and
            $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual|VPN|Hyper-V'
        } |
        Select-Object -ExpandProperty IPAddress
}
