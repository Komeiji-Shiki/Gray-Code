using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace GrayCode.ComputerHost {
  // 只读命令模式在初始化桌面控制前退出，与窗口操作和控制租约无关。
  internal static class ProcessSnapshot {
    private const long UnixFileTime=116444736000000000L;
    private const uint SnapProcesses=2,QueryLimitedInformation=0x1000;
    private const int NoMoreFiles=18;
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
    private struct ProcessEntry {
      public uint Size,Usage,Pid;
      public UIntPtr DefaultHeap;
      public uint ModuleId,Threads,ParentPid;
      public int BasePriority;
      public uint Flags;
      [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
    }
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] private static extern bool Process32FirstW(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] private static extern bool Process32NextW(IntPtr snapshot,ref ProcessEntry entry);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool ProcessIdToSessionId(uint pid,out uint sessionId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    internal static void Write() {
      var startedAt=DateTime.UtcNow.ToFileTimeUtc();
      var snapshot=CreateToolhelp32Snapshot(SnapProcesses,0);
      if(snapshot==new IntPtr(-1))throw new Win32Exception(Marshal.GetLastWin32Error());
      try {
        var entry=new ProcessEntry {Size=(uint)Marshal.SizeOf(typeof(ProcessEntry))};
        if(!Process32FirstW(snapshot,ref entry))throw new Win32Exception(Marshal.GetLastWin32Error());
        var output=new StringBuilder();
        do {
          if(entry.Pid==0)continue;
          uint session;var hasSession=ProcessIdToSessionId(entry.Pid,out session);
          var process=OpenProcess(QueryLimitedInformation,false,entry.Pid);
          if(process==IntPtr.Zero) {Append(output,entry,"?",hasSession?session.ToString(CultureInfo.InvariantCulture):"");continue;}
          try {
            long created,exited,kernel,user;
            var known=GetProcessTimes(process,out created,out exited,out kernel,out user);
            if(known&&exited!=0)continue;
            // 父 PID 来自快照，创建时间来自进程句柄；排除快照后创建的进程，避免 PID 复用时拼接两代身份。
            var identity=known&&created>UnixFileTime&&created<=startedAt
              ?((created-UnixFileTime)/10000).ToString(CultureInfo.InvariantCulture):"?";
            Append(output,entry,identity,hasSession?session.ToString(CultureInfo.InvariantCulture):"");
          } finally {CloseHandle(process);}
        } while(Process32NextW(snapshot,ref entry));
        var error=Marshal.GetLastWin32Error();
        if(error!=NoMoreFiles)throw new Win32Exception(error);
        Console.Write(output.ToString());
      } finally {CloseHandle(snapshot);}
    }
    private static void Append(StringBuilder output,ProcessEntry entry,string created,string session) {
      output.Append(entry.Pid.ToString(CultureInfo.InvariantCulture)).Append('\t')
        .Append(entry.ParentPid.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(created).Append('\t')
        .Append(session).Append('\t').Append(entry.Name).AppendLine();
    }
  }
}
