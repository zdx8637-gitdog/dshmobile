$files = 'question-probe.mjs','diag-probe.mjs','run-probe.mjs','replay-probe.mjs'
$old = 'const online = (dev.data || []).find((d) => d.status === "online");'
$new = 'const online = (dev.data || []).find((d) => d.status === "online" && d.label === "DSH Bridge (windows-p)");'
foreach ($f in $files) {
  $p = "D:\p\dsh-remote\test\$f"
  $c = Get-Content $p -Raw
  if ($c.Contains($old)) {
    $c = $c.Replace($old, $new)
    Set-Content $p -Value $c -NoNewline
    "patched: $f"
  } else {
    "no match: $f"
  }
}
