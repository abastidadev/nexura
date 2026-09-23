import { execFile } from "node:child_process";

/**
 * Explorer-style "Select folder" dialog (IFileOpenDialog with FOS_PICKFOLDERS) through
 * PowerShell, owned by an invisible topmost form so it does not open behind the browser.
 * The initial folder arrives in an environment variable: no user text in the script.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexuraFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr bindContext, ref Guid iid, out IShellItem item);

  const uint PICK_FOLDERS = 0x20, FORCE_FILESYSTEM = 0x40, FILESYSPATH = 0x80058000;

  public static string Pick(IntPtr owner, string initial, string title) {
    var dialog = (IFileDialog)new FileOpenDialog();
    dialog.SetOptions(PICK_FOLDERS | FORCE_FILESYSTEM);
    dialog.SetTitle(title);
    if (!string.IsNullOrEmpty(initial)) {
      try {
        var iid = typeof(IShellItem).GUID;
        IShellItem folder;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
        dialog.SetFolder(folder);
      } catch { }
    }
    if (dialog.Show(owner) != 0) return "";
    IShellItem result;
    dialog.GetResult(out result);
    string path;
    result.GetDisplayName(FILESYSPATH, out path);
    return path;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }
$owner.Show()
$owner.Activate()
try {
  [Console]::Out.Write([NexuraFolderPicker]::Pick($owner.Handle, $env:NEXURA_PICK_INITIAL, 'Nexura · Elige la carpeta del repo'))
} finally {
  $owner.Close()
}
`;

/**
 * zenity and osascript exit non-zero when the user cancels: that is an empty answer.
 * PowerShell returns "" itself on cancel, so its non-zero exit is a real error.
 */
function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const missing = (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
      if (error && (missing || process.platform === "win32")) {
        reject(new Error(`No se pudo abrir el selector de carpetas: ${missing ? `falta ${command}` : stderr.trim().slice(0, 300)}`));
        return;
      }
      resolve(error ? "" : stdout.trim());
    });
  });
}

/** Opens the OS folder dialog and resolves with the chosen path, or "" when cancelled. */
export function pickFolder(initial = ""): Promise<string> {
  if (process.platform === "win32") {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SCRIPT], {
      ...process.env,
      NEXURA_PICK_INITIAL: initial,
    });
  }
  if (process.platform === "darwin") {
    return run("osascript", ["-e", 'POSIX path of (choose folder with prompt "Elige la carpeta del repo")']).then((path) => path.replace(/\/$/, ""));
  }
  return run("zenity", ["--file-selection", "--directory", "--title=Elige la carpeta del repo", ...(initial ? [`--filename=${initial}/`] : [])]);
}
