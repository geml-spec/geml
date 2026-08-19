# Windows Explorer icons for `.geml` / `.gemlhistory`

Gives GEML files the GEML logo in Windows Explorer. Per-user (HKCU), no
administrator rights; the icon is copied to `%LOCALAPPDATA%\GEML\geml.ico`
so it survives moving or deleting this checkout.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Optionally register the double-click handler in the same pass (recommended —
otherwise Windows' first "open with" prompt can record a choice whose icon
overrides this one):

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -OpenWith "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
```

Undo everything:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

The script refuses to overwrite an association another tool already owns
(`-Force` overrides), and uninstall removes only what it created. If icons
look stale afterwards, sign out and back in — Explorer's icon cache lags.

The icon lives at [`docs/assets/logo/geml.ico`](../../docs/assets/logo/geml.ico),
built from [`../vscode/icon.png`](../vscode/icon.png) (7 sizes, 16–128 px,
PNG-compressed entries).
