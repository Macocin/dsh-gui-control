# Minimal global hotkey sender for the halt tests: presses a combo with the
# real SendInput path so RegisterHotKey in the helper sees a normal keystroke.
# ASCII only (PowerShell 5.1 reads BOM-less .ps1 as ANSI).
#
#   powershell -File test/_sendhotkey.ps1 ctrl+shift+c
#   powershell -File test/_sendhotkey.ps1 ctrl+shift+c -Then v

param(
    [Parameter(Mandatory = $true)][string]$Combo,
    [string]$Then = '',
    [int]$GapMs = 120
)

$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class HotkeySender
{
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public INPUTUNION u; }

    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);

    static ushort Vk(string name)
    {
        switch (name.Trim().ToLowerInvariant())
        {
            case "ctrl": case "control": return 0xA2;
            case "shift": return 0xA0;
            case "alt": return 0xA4;
            case "win": return 0x5B;
            case "c": return 0x43;
            case "v": return 0x56;
            case "x": return 0x58;
            case "a": return 0x41;
            default: throw new ArgumentException("unknown key: " + name);
        }
    }

    static void Send(ushort vk, bool up)
    {
        INPUT[] inp = new INPUT[1];
        inp[0].type = 1;
        inp[0].u.ki.vk = vk;
        inp[0].u.ki.scan = (ushort)MapVirtualKey(vk, 0);
        inp[0].u.ki.flags = up ? 0x0002u : 0u;
        SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Combo(string spec, int gapMs)
    {
        string[] parts = spec.Split('+');
        List<ushort> held = new List<ushort>();
        foreach (string p in parts) { ushort vk = Vk(p); Send(vk, false); held.Add(vk); Thread.Sleep(25); }
        Thread.Sleep(gapMs);
        for (int i = held.Count - 1; i >= 0; i--) { Send(held[i], true); Thread.Sleep(20); }
    }

    public static void Tap(string spec, int gapMs)
    {
        ushort vk = Vk(spec);
        Send(vk, false); Thread.Sleep(gapMs); Send(vk, true);
    }
}
'@

Add-Type -TypeDefinition $src
[HotkeySender]::Combo($Combo, 90)
if ($Then -ne '') {
    Start-Sleep -Milliseconds $GapMs
    [HotkeySender]::Tap($Then, 90)
}
Write-Output 'sent'
