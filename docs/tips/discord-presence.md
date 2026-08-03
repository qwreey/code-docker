# Discord presence

기본적으로 [LeonardSSH.vscord](https://open-vsx.org/vscode/item?itemName=LeonardSSH.vscord) 확장 사용을 권장합니다. 사용 가능함이 확인되었으며, `"vscord.app.privacyMode.enable": true,` 를 통해 민감 정보를 바꾸거나 포멧을 바꾸는 등 설정이 쉽습니다.

디스코드는 unix 소켓을 `$XDG_RUNTIME_DIR` 에 노출시킵니다. 따라서 해당 소켓을
`ssh -R /run/xdg/discord-ipc-0:$XDG_RUNTIME_DIR/discord-ipc-0 code` 형태로 전송하면 작동하게 됩니다.
이것을 자동화 하기 위해 `autossh` 등의 도구를 사용하는것을 고려하세요. 이를 로컬 데스크탑 환경의 autolaunch 또는 service 요소로 등록하면 지속적으로 사용가능합니다.

autossh 를 authlaunch 로 등록하려면 `~/.config/autostart/discord-tunnel.desktop` 에 다음을 작성하세요.
```conf
[Desktop Entry]
Type=Application
Name=Discord IPC Tunnel
Exec=/usr/bin/autossh -M 0 -N -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" -o "ExitOnForwardFailure yes" -R /run/xdg/discord-ipc-0:/run/user/1000/discord-ipc-0 code
X-KDE-autostart-after=panel
X-GNOME-Autostart-enabled=true
```
