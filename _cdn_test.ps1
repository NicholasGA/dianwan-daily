$ErrorActionPreference = 'Stop'

# host -> sample url
$samples = [ordered]@{
  'alioss.yystv.cn'        = 'https://alioss.yystv.cn/doc/14046/0555ad7d1c01cb4da62a66092a99f96e.appmsg_mw680water'
  'assets-prd.ignimgs.com' = 'https://assets-prd.ignimgs.com/2026/06/11/ss-7ef7d3bf6f9577927ac6ca7445c29f045640aee2-1920x1080-1781175040180.jpg'
  'assets1.ignimgs.com'    = 'https://assets1.ignimgs.com/2019/08/27/fire-emblem-three-houses-1566939583866.jpg'
  'hivebak.indienova.com'  = 'https://hivebak.indienova.com/farm/article/headpic/2026/06/head-4353BZ-banner-2.jpg'
  'i.17173cdn.com'         = 'https://i.17173cdn.com/2fhnvk/YWxqaGBf/cms3/qTbNexbtAAgucEq.jpg'
  'image.gamersky.com'     = 'https://image.gamersky.com/webimg15/content/loading.gif'
  'image.gcores.com'       = 'https://image.gcores.com/98ad208a8d953eb5702c63aac1e40d1f-681-361.png?x-oss-process=image/resize,limit_1,m_fill,w_626,h_292/quality,q_90'
  'img.3dmgame.com'        = 'https://img.3dmgame.com/uploads/images/thumbnews/2026/0611/1781156678979.jpg'
  'img.chuapp.com'         = 'http://img.chuapp.com/wp-content/Picture/2026-06-10/6a292c8adaa22.jpg?imageView2/2/w/700'
  'img1.gamersky.com'      = 'https://img1.gamersky.com/upimg/pic/2026/06/11/small_202606112017203144.jpg'
  'img1.mydrivers.com'     = 'https://img1.mydrivers.com/img/20260611/S62a2fa15-f432-4b1d-b337-32581ff4a1ca.png'
  'img1b.gamersky.com'     = 'https://img1b.gamersky.com/users/recommend/2026/06/11/origin_1913368_2149063.jpg'
  'imggif.gamersky.com'    = 'https://imggif.gamersky.com/upimg/pic/2026/06/11/small_202606112023468369.gif'
  'imgs.gamersky.com'      = 'https://imgs.gamersky.com/upimg/new_preview/2026/06/11/origin_b_202606112015596695.jpg'
  'www.gamespot.com'       = 'https://www.gamespot.com/wp-content/uploads/2026/06/Kojima-and-Keighley.png?w=300'
}

$referer = 'https://nicholasga.github.io/'

function Probe([string]$url, [hashtable]$headers) {
  try {
    $p = @{ Uri = $url; Method = 'Head'; TimeoutSec = 12; MaximumRedirection = 5;
            UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($headers) { $p.Headers = $headers }
    $r = Invoke-WebRequest @p
    return [string]$r.StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp -ne $null) {
      try { return 'ERR-' + [int]$resp.StatusCode } catch {}
    }
    $m = $_.Exception.Message
    if ($m -match '\b(\d{3})\b') { return 'ERR-' + $matches[1] }
    if ($m -match 'timed out|timeout') { return 'TIMEOUT' }
    if ($m -match 'remote name|resolve|No such host|known') { return 'DNS-FAIL' }
    if ($m -match 'connection|connect') { return 'CONN-FAIL' }
    if ($m -match 'SSL|TLS|trust') { return 'TLS-FAIL' }
    return 'ERR:' + ($m -replace '\s+', ' ').Substring(0, [Math]::Min(60, $m.Length))
  }
}

$results = @()
foreach ($h in $samples.Keys) {
  $url = $samples[$h]
  # (a) direct, no referer
  $a = Probe $url $null
  # (b) with referer
  $b = Probe $url @{ 'Referer' = $referer }
  # (c) via wsrv.nl  (strip protocol prefix, url-encode)
  $stripped = $url -replace '^https?://', ''
  $enc = [System.Uri]::EscapeDataString($stripped)
  $proxyUrl = 'https://wsrv.nl/?url=' + $enc
  $c = Probe $proxyUrl $null

  $results += [pscustomobject]@{
    host       = $h
    directHttps= $a
    withReferer= $b
    viaWsrv    = $c
  }
  Write-Host ("{0,-26} a={1,-10} b={2,-10} c={3}" -f $h, $a, $b, $c)
}

$results | ConvertTo-Json -Depth 4 | Out-File -FilePath 'G:\game-news-app\_cdn_results.json' -Encoding utf8
Write-Host "DONE"
