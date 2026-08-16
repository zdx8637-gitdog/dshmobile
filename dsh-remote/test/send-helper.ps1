$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"

function Send-Text($text) {
    & $adb shell uiautomator dump /sdcard/ui.xml 2>$null | Out-Null
    $xml = & $adb shell cat /sdcard/ui.xml 2>$null
    $inp = ($xml -replace '><', "`n<") -split "`n" | Where-Object { $_ -match 'class="android.widget.EditText"' } | Select-Object -First 1
    if ($inp -match 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') {
        $ix = ([int]$Matches[1] + [int]$Matches[3]) / 2
        $iy = ([int]$Matches[2] + [int]$Matches[4]) / 2
        & $adb shell input tap $ix $iy
        Start-Sleep -Milliseconds 400
        & $adb shell input text $text
        Start-Sleep -Milliseconds 300
    }
    & $adb shell uiautomator dump /sdcard/ui.xml 2>$null | Out-Null
    $xml = & $adb shell cat /sdcard/ui.xml 2>$null
    $btn = ($xml -replace '><', "`n<") -split "`n" | Where-Object { $_ -match 'text="发送"|content-desc="发送"' } | Select-Object -First 1
    if ($btn -match 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"') {
        $bx = ([int]$Matches[1] + [int]$Matches[3]) / 2
        $by = ([int]$Matches[2] + [int]$Matches[4]) / 2
        & $adb shell input tap $bx $by
        "sent at $bx,$by"
    } else {
        "send button not found"
    }
}

Send-Text "edit%starget%sone"
