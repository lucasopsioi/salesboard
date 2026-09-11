# -*- coding: utf-8 -*-
"""弹本机 WinForms 掩码窗口收 DeepSeek key,直写 eval/deepseek.key。
密钥纪律:输入框掩码显示、key 不打印不回传,本脚本仅输出"已保存(长度N)/已取消"。
中文 PS 走 -EncodedCommand(UTF-16LE)——cp936 铁律。"""
import base64
import io
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_PATH = os.path.join(ROOT, 'eval', 'deepseek.key')

PS = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DeepSeek API Key'
$form.Size = New-Object System.Drawing.Size(520, 200)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Location = New-Object System.Drawing.Point(16, 15)
$label.Size = New-Object System.Drawing.Size(480, 40)
$label.Text = "粘贴你的 DeepSeek API Key 后点「保存」。`n仅写入本机 Salesboard\eval\deepseek.key，掩码显示、不上传、不进对话。"
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(16, 62)
$box.Size = New-Object System.Drawing.Size(472, 26)
$box.UseSystemPasswordChar = $true
$box.Font = New-Object System.Drawing.Font('Consolas', 11)
$form.Controls.Add($box)

$ok = New-Object System.Windows.Forms.Button
$ok.Location = New-Object System.Drawing.Point(300, 105)
$ok.Size = New-Object System.Drawing.Size(90, 30)
$ok.Text = '保存'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)
$form.AcceptButton = $ok

$cancel = New-Object System.Windows.Forms.Button
$cancel.Location = New-Object System.Drawing.Point(398, 105)
$cancel.Size = New-Object System.Drawing.Size(90, 30)
$cancel.Text = '取消'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  $k = $box.Text.Trim()
  if ($k.Length -lt 10) { Write-Output 'TOOSHORT'; exit 0 }
  [System.IO.File]::WriteAllText('__KEYPATH__', $k, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output ('SAVED ' + $k.Length)
} else {
  Write-Output 'CANCELLED'
}
"""


def main():
    ps = PS.replace('__KEYPATH__', KEY_PATH.replace("'", "''"))
    enc = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
    r = subprocess.run(
        ['powershell', '-NoProfile', '-STA', '-EncodedCommand', enc],
        capture_output=True, text=True, timeout=560,
    )
    out = (r.stdout or '').strip()
    if out.startswith('SAVED'):
        n = out.split()[-1]
        print('OK: key saved to eval/deepseek.key (length %s), never displayed.' % n)
        sys.exit(0)
    if out == 'TOOSHORT':
        print('REJECTED: input under 10 chars, nothing written. Run again.')
        sys.exit(2)
    if out == 'CANCELLED':
        print('CANCELLED: user closed the dialog, nothing written.')
        sys.exit(3)
    print('UNEXPECTED: %s / %s' % (out[:80], (r.stderr or '')[:120]))
    sys.exit(4)


if __name__ == '__main__':
    main()
